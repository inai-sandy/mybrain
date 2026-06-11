import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { TasksService } from '../tasks/tasks.service';
import { PromptsService } from '../prompts/prompts.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const SUMMARY_AT = '21:30'; // local time the auto day-summary fires
const STORY_AT = '23:58'; // local time the nightly Story of the Day fires
const DEFAULT_STORY_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

type TimelineEvent = { type: string; title: string; detail?: string; at: string };

@Injectable()
export class DailyService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly memory: MemoryService,
    private readonly tasks: TasksService,
    private readonly prompts: PromptsService,
  ) {}

  onModuleInit() {
    this.tick = setInterval(() => {
      this.summaryTick().catch(() => undefined);
      this.storyTick().catch(() => undefined);
      this.monthTick().catch(() => undefined);
      this.yearTick().catch(() => undefined);
      this.personalityTick().catch(() => undefined);
    }, 60_000);
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  private async tz(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } });
    return row?.value || DEFAULT_TZ;
  }

  /** Local day key (YYYY-MM-DD) in the user's timezone. */
  private dayKey(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }

  /** Add n days to a YYYY-MM-DD key (n can be negative). */
  private dayAdd(day: string, n: number): string {
    const d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  /** Local HH:MM in the user's timezone. */
  private localHM(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    } catch {
      return d.toISOString().slice(11, 16);
    }
  }

  /** Once past the summary time, generate today's summary if it isn't done yet. */
  async summaryTick(): Promise<void> {
    const tz = await this.tz();
    if (this.localHM(tz) < SUMMARY_AT) return;
    const day = this.dayKey(tz);
    const existing = await this.prisma.daySummary.findUnique({ where: { day } });
    if (existing) return;
    await this.generateSummary(day).catch(() => undefined);
  }

  // ---- nightly story (one per day) ----

  async submitStory(rawText: string, source = 'app', mood?: string, forDay?: string) {
    const text = (rawText || '').trim();
    if (!text) return null;
    const today = this.dayKey(await this.tz());
    // Telling a past day's story (e.g. the morning after) is allowed; the future is not.
    const day = forDay && /^\d{4}-\d{2}-\d{2}$/.test(forDay) && forDay <= today ? forDay : today;
    const existing = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const row = existing
      ? await this.prisma.story.update({ where: { id: existing.id }, data: { rawText: text, source, mood: mood ?? existing.mood } })
      : await this.prisma.story.create({ data: { day, rawText: text, source, mood: mood || null } });
    // Index his own words into memory so "My life" chat can answer from them ("what was I worried about in May?").
    await this.memory.enqueue(`His own story — ${day}${mood ? ` (mood: ${mood})` : ''}\n\n${text}`, { title: `Your story ${day}`, tags: ['activity'] }).catch(() => undefined);
    // If that day's Story of the Day was already written, rewrite it around the user's own words.
    const woven = await this.prisma.dayStory.findUnique({ where: { day } });
    if (woven) this.generateDayStory(day, true).catch(() => undefined);
    return { ...this.shapeStory(row), rewriting: !!woven };
  }

  private shapeStory(s: any) {
    return { id: s.id, day: s.day, text: s.rawText, source: s.source, mood: s.mood, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  // ---- daytime notes ----

  async addNote(text: string, source = 'app') {
    const t = (text || '').trim();
    if (!t) return null;
    const day = this.dayKey(await this.tz());
    const row = await this.prisma.dayNote.create({ data: { day, text: t.slice(0, 2000), source } });
    return { id: row.id, day: row.day, text: row.text, source: row.source, createdAt: row.createdAt };
  }

  async deleteNote(id: string) {
    await this.prisma.dayNote.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  /** Today's story + notes for the daily loop. */
  async today() {
    const day = this.dayKey(await this.tz());
    const story = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const notes = await this.prisma.dayNote.findMany({ where: { day }, orderBy: { createdAt: 'desc' } });
    return {
      day,
      storyDone: !!story,
      story: story ? this.shapeStory(story) : null,
      notes: notes.map((n) => ({ id: n.id, text: n.text, source: n.source, createdAt: n.createdAt })),
    };
  }

  // ---- activity (auto-captured timeline + AI day-summary) ----

  /** Derive the day's timeline from everything the user did in the app (no write-path instrumentation needed). */
  async feed(day: string, tz: string): Promise<TimelineEvent[]> {
    const onDay = (d: Date | string | null) => !!d && this.dayKey(tz, new Date(d)) === day;
    const ev: TimelineEvent[] = [];

    const [items, ideas, skills, doneTasks, dumps, story, notes] = await Promise.all([
      this.prisma.item.findMany({ orderBy: { createdAt: 'desc' }, take: 800 }),
      this.prisma.idea.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
      this.prisma.skill.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }),
      this.prisma.task.findMany({ where: { status: 'done', day }, orderBy: { completedAt: 'desc' } }),
      this.prisma.brainDump.findMany({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.dayNote.findMany({ where: { day }, orderBy: { createdAt: 'desc' } }),
    ]);

    for (const it of items) {
      if (!onDay(it.createdAt)) continue;
      if (it.source === 'raindrop') ev.push({ type: 'bookmark', title: it.title || 'Bookmark', detail: 'Saved a bookmark', at: it.createdAt as any });
      else ev.push({ type: 'capture', title: it.title || 'Document', detail: 'Saved to your brain', at: it.createdAt as any });
    }
    for (const id of ideas) if (onDay(id.createdAt)) ev.push({ type: 'idea', title: id.title, detail: 'Captured an idea', at: id.createdAt as any });
    for (const sk of skills) if (onDay(sk.createdAt)) ev.push({ type: 'skill', title: sk.title, detail: 'Tracked a Claude skill', at: sk.createdAt as any });
    for (const t of doneTasks) ev.push({ type: 'task', title: t.title, detail: t.actualMin ? `Finished a task · ${t.actualMin}m` : 'Finished a task', at: (t.completedAt || t.createdAt) as any });
    for (const d of dumps) ev.push({ type: 'dump', title: `Brain dump → ${d.taskCount} task${d.taskCount === 1 ? '' : 's'}`, at: d.createdAt as any });
    if (story) ev.push({ type: 'story', title: 'Told the day’s story', detail: story.mood || undefined, at: (story.updatedAt || story.createdAt) as any });
    for (const n of notes) ev.push({ type: 'note', title: n.text.slice(0, 120), detail: 'Quick note', at: n.createdAt as any });

    return ev.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }

  async stats(day: string) {
    const dayTasks = await this.prisma.task.findMany({ where: { day } });
    const done = dayTasks.filter((t) => t.status === 'done');
    const minutesSpent = done.reduce((s, t) => s + (t.actualMin || 0), 0);
    const estimated = dayTasks.reduce((s, t) => s + (t.estimateMin || 0), 0);
    return {
      tasksTotal: dayTasks.length,
      tasksDone: done.length,
      tasksOpen: dayTasks.length - done.length,
      minutesSpent,
      minutesEstimated: estimated,
    };
  }

  /** Build (or rebuild) the AI day-summary, store it, and index it to RAG + SuperMemory (tagged "activity"). */
  async generateSummary(day: string, force = false) {
    const tz = await this.tz();
    if (!force) {
      const existing = await this.prisma.daySummary.findUnique({ where: { day } });
      if (existing) return this.shapeSummary(existing);
    }
    const [timeline, st, story, dayTasks] = await Promise.all([
      this.feed(day, tz),
      this.stats(day),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { day } }),
    ]);

    const doneList = dayTasks.filter((t) => t.status === 'done').map((t) => `✓ ${t.title}${t.actualMin ? ` (${t.actualMin}m)` : ''}`);
    const openList = dayTasks.filter((t) => t.status !== 'done').map((t) => `○ ${t.title}${t.rolloverCount ? ` [carried ${t.rolloverCount}d]` : ''}`);
    const activityLines = timeline.filter((e) => e.type !== 'task').map((e) => `- ${e.title}`);

    const tmpl = await this.prompts.get('daily.summary');
    const prompt =
      `${tmpl}\n\n` +
      `Tasks done (${st.tasksDone}/${st.tasksTotal}, ~${st.minutesSpent}m):\n${doneList.join('\n') || '(none)'}\n\n` +
      `Still pending:\n${openList.join('\n') || '(none)'}\n\n` +
      `Other activity in the app:\n${activityLines.join('\n') || '(none)'}\n\n` +
      `His story of the day${story?.mood ? ` (mood: ${story.mood})` : ''}:\n${story?.rawText?.slice(0, 2000) || '(not told)'}`;

    const text = (await this.llm.completeWith(await this.tasks.getModel(), prompt, 900, 'day-summary'))?.trim() || this.fallbackSummary(st, doneList, openList);
    const stats = JSON.stringify(st);
    const row = await this.prisma.daySummary.upsert({
      where: { day },
      create: { day, text, stats },
      update: { text, stats },
    });

    // Index the day so it's searchable by meaning, stamped "activity" so SuperMemory sync never duplicates it.
    await this.memory.enqueue(`Day summary — ${day}\n\n${text}`, { title: `Day summary ${day}`, tags: ['activity'] }).catch(() => undefined);
    return this.shapeSummary(row);
  }

  private fallbackSummary(st: any, done: string[], open: string[]): string {
    return `On ${st.tasksTotal} planned tasks you finished ${st.tasksDone} (~${st.minutesSpent} min).\n\nDone:\n${done.join('\n') || '(none)'}\n\nPending:\n${open.join('\n') || '(none)'}`;
  }

  private shapeSummary(s: any) {
    let stats: any = null;
    try {
      stats = s.stats ? JSON.parse(s.stats) : null;
    } catch {
      /* ignore */
    }
    return { day: s.day, text: s.text, stats, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  // ---- Story of the Day (nightly, 11:58 PM) ----

  /** The model that writes the Story of the Day (own picker; defaults to Sonnet). */
  async storyModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'story.llm' } });
    if (!row) return DEFAULT_STORY_MODEL;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : DEFAULT_STORY_MODEL;
    } catch {
      return DEFAULT_STORY_MODEL;
    }
  }
  async setStoryModel(provider: string, model: string) {
    const value = JSON.stringify({ provider, model });
    await this.prisma.setting.upsert({ where: { key: 'story.llm' }, create: { key: 'story.llm', value }, update: { value } });
    return { provider, model };
  }
  /** OpenAI + Anthropic models for the Settings pickers (shared with Tasks). */
  async listModels() {
    return this.tasks.listModels();
  }

  shapeDayStory(s: any) {
    return { day: s.day, text: s.text, mood: s.mood, moodScore: s.moodScore, model: s.model, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  async getDayStory(day: string) {
    const row = await this.prisma.dayStory.findUnique({ where: { day } });
    return row ? this.shapeDayStory(row) : null;
  }

  /** At 11:58 PM local, write today's Story of the Day (and tomorrow's suggested tasks). If the
   *  late-night window was missed (deploy/restart), catch up on YESTERDAY's story the next day. */
  async storyTick(): Promise<void> {
    const tz = await this.tz();
    const day = this.dayKey(tz);
    if (this.localHM(tz) >= STORY_AT) {
      if (await this.prisma.dayStory.findUnique({ where: { day } })) return;
      await this.generateDayStory(day).catch(() => undefined);
      // Tonight's story (day) drives tomorrow's suggestions (day + 1).
      await this.generateSuggestions(this.dayAdd(day, 1)).catch(() => undefined);
    } else {
      const y = this.dayAdd(day, -1);
      if (await this.prisma.dayStory.findUnique({ where: { day: y } })) return;
      const [told, taskCount] = await Promise.all([
        this.prisma.story.findFirst({ where: { day: y } }),
        this.prisma.task.count({ where: { day: y } }),
      ]);
      if (!told && !taskCount) return; // nothing happened that day — nothing to backfill
      await this.generateDayStory(y).catch(() => undefined);
      await this.generateSuggestions(day).catch(() => undefined); // yesterday's story drives TODAY's picks
    }
  }

  /** Weave the told story + the day's tasks + the activity timeline into one emotional Story of the Day. */
  async generateDayStory(day: string, force = false) {
    const tz = await this.tz();
    if (!force) {
      const existing = await this.prisma.dayStory.findUnique({ where: { day } });
      if (existing) return this.shapeDayStory(existing);
    }
    const [timeline, st, told, dayTasks] = await Promise.all([
      this.feed(day, tz),
      this.stats(day),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { day } }),
    ]);

    const doneList = dayTasks
      .filter((t) => t.status === 'done')
      .map((t) => `✓ ${t.title}${t.category ? ` [${t.category}]` : ''}${t.actualMin ? ` (${t.actualMin}m)` : ''}`);
    const partialList = dayTasks
      .filter((t) => t.status !== 'done' && (t.progress || 0) > 0)
      .map((t) => `◐ ${t.title} — ${t.progress}% done`);
    const openList = dayTasks.filter((t) => t.status !== 'done' && !(t.progress || 0)).map((t) => `○ ${t.title}`);
    const activityLines = timeline.filter((e) => e.type !== 'task').map((e) => `- ${e.title}${e.detail ? ` (${e.detail})` : ''}`);

    const tmpl = await this.prompts.get('story.daily');
    const prompt =
      `${tmpl}\n\n` +
      `=== DATE: ${day} ===\n\n` +
      `HIS STORY (own words${told?.mood ? `, mood: ${told.mood}` : ''}):\n${told?.rawText?.slice(0, 3000) || '(he did not tell a story today)'}\n\n` +
      `TASKS DONE (${st.tasksDone}/${st.tasksTotal}, ~${st.minutesSpent}m):\n${doneList.join('\n') || '(none)'}\n\n` +
      (partialList.length ? `TASKS IN PROGRESS:\n${partialList.join('\n')}\n\n` : '') +
      `TASKS STILL OPEN:\n${openList.join('\n') || '(none)'}\n\n` +
      `ACTIVITY TIMELINE:\n${activityLines.join('\n') || '(quiet day in the app)'}`;

    const cfg = await this.storyModel();
    const raw = (await this.llm.completeWith(cfg, prompt, 1400, 'story-of-day'))?.trim() || '';
    let text = raw;
    let mood: string | null = told?.mood || null;
    let moodScore: number | null = null;
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (json?.story) text = String(json.story).trim();
      if (json?.mood) mood = String(json.mood).slice(0, 40);
      if (Number.isFinite(json?.moodScore)) moodScore = Math.max(0, Math.min(100, Math.round(Number(json.moodScore))));
    } catch {
      /* model returned prose, not JSON — keep it as the story */
    }
    if (!text) text = this.fallbackSummary(st, doneList, openList);

    const row = await this.prisma.dayStory.upsert({
      where: { day },
      create: { day, text, mood, moodScore, model: cfg.model },
      update: { text, mood, moodScore, model: cfg.model },
    });

    // Store the Story of the Day in BOTH memory stores (tagged "activity" so SuperMemory sync never re-imports it).
    await this.memory.enqueue(`Story of the Day — ${day}\n\n${text}`, { title: `Story of the Day ${day}`, tags: ['activity'] }).catch(() => undefined);
    // People memory: remember who appeared in his own words — story, tasks AND quick notes
    // (tasks come from his brain dumps, so "Discuss payments with Srikar" counts as a mention).
    const dayNotes = await this.prisma.dayNote.findMany({ where: { day } }).catch(() => [] as any[]);
    const peopleCorpus = [told?.rawText, dayTasks.map((t) => t.title).join('\n'), dayNotes.map((n: any) => n.text).join('\n')]
      .filter(Boolean)
      .join('\n');
    if (peopleCorpus.trim()) await this.extractPeople(day, peopleCorpus).catch(() => undefined);
    // Flag it for the Telegram push (delivered by the Telegram nudge loop).
    await this.setSetting('telegram.pushStory', day).catch(() => undefined);
    return this.shapeDayStory(row);
  }

  // ---- Story of the Month (the chapters of the year book) ----

  private shapeMonthStory(m: any) {
    return { month: m.month, title: m.title, text: m.text, createdAt: m.createdAt, updatedAt: m.updatedAt };
  }

  /** Written chapters + months that have day-stories but no chapter yet (offered for on-demand writing). */
  async listMonths() {
    const [chapters, dayStories] = await Promise.all([
      this.prisma.monthStory.findMany({ orderBy: { month: 'desc' } }),
      this.prisma.dayStory.findMany({ select: { day: true } }),
    ]);
    const have = new Set(chapters.map((c: any) => c.month));
    const pending = [...new Set(dayStories.map((s: any) => s.day.slice(0, 7)))].filter((m) => !have.has(m)).sort().reverse();
    return { chapters: chapters.map((c: any) => this.shapeMonthStory(c)), pending, count: chapters.length };
  }

  /** Weave a month's Stories of the Day (+ weekly reviews) into one chapter. */
  async generateMonthStory(month: string, force = false) {
    if (!/^\d{4}-\d{2}$/.test(month)) return null;
    if (!force) {
      const existing = await this.prisma.monthStory.findUnique({ where: { month } });
      if (existing) return this.shapeMonthStory(existing);
    }
    const [stories, weeklies] = await Promise.all([
      this.prisma.dayStory.findMany({ where: { day: { gte: `${month}-01`, lte: `${month}-31` } }, orderBy: { day: 'asc' } }),
      this.prisma.weeklyReview.findMany({ where: { weekStart: { gte: `${month}-01`, lte: `${month}-31` } }, orderBy: { weekStart: 'asc' } }),
    ]);
    if (stories.length < 3) return null; // not enough recorded days to call it a chapter

    const dayLines = stories.map((s: any) => `• ${s.day}${s.moodScore != null ? ` (mood ${s.moodScore})` : ''}: ${s.text.replace(/\s+/g, ' ').slice(0, 600)}`);
    const weekLines = weeklies.map((w: any) => `• Week of ${w.weekStart}: pattern — ${w.pattern || '-'}; experiment — ${w.experiment || '-'}`);

    const tmpl = await this.prompts.get('story.month');
    const prompt =
      `${tmpl}\n\n` +
      `=== THE MONTH: ${month} (${stories.length} recorded days) ===\n${dayLines.join('\n')}\n\n` +
      `=== WEEKLY REVIEWS ===\n${weekLines.join('\n') || '(none that month)'}`;

    const cfg = await this.storyModel();
    const raw = (await this.llm.completeWith(cfg, prompt, 2200, 'story-of-month'))?.trim() || '';
    let text = raw;
    let title: string | null = null;
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (json?.story) text = String(json.story).trim();
      if (json?.title) title = String(json.title).trim().slice(0, 120);
    } catch {
      /* keep prose */
    }
    if (!text) return null;

    const row = await this.prisma.monthStory.upsert({
      where: { month },
      create: { month, title, text },
      update: { title, text },
    });
    await this.memory.enqueue(`Story of the Month — ${month}${title ? ` — ${title}` : ''}\n\n${text}`, { title: `Story of the Month ${month}`, tags: ['activity'] }).catch(() => undefined);
    return this.shapeMonthStory(row);
  }

  /** On the 1st of each month (after 00:20 local), write last month's chapter. A chapter written
   *  DURING its month (on demand) is only a draft — once the month closes, rewrite it with the full
   *  month so the book never keeps a half-month chapter. Once-a-day try guard. */
  async monthTick(): Promise<void> {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    if (!today.endsWith('-01') || this.localHM(tz) < '00:20') return;
    const prevMonth = this.dayAdd(today, -1).slice(0, 7);
    const existing = await this.prisma.monthStory.findUnique({ where: { month: prevMonth } });
    // skip only if the chapter was (re)written AFTER its month closed — i.e. on/after the 1st
    if (existing && this.dayKey(tz, new Date(existing.updatedAt)) > `${prevMonth}-31`) return;
    const tried = (await this.prisma.setting.findUnique({ where: { key: 'story.monthTry' } }))?.value;
    if (tried === today) return;
    await this.setSetting('story.monthTry', today);
    await this.generateMonthStory(prevMonth, !!existing).catch(() => undefined);
  }

  // ---- people memory: who appears in his stories ----

  /** Learned spelling aliases (from merges): { "Allison": "Alisan" } — applied to every future extraction. */
  private async peopleAliases(): Promise<Record<string, string>> {
    try {
      return JSON.parse((await this.prisma.setting.findUnique({ where: { key: 'people.aliases' } }))?.value || '{}');
    } catch {
      return {};
    }
  }

  /** Merge one person into another: rewrite all mentions (deduped per day) and remember the alias forever. */
  async mergePeople(from: string, into: string) {
    const f = String(from || '').trim();
    const t = String(into || '').trim();
    if (!f || !t || f.toLowerCase() === t.toLowerCase()) return null;
    const mentions = await this.prisma.personMention.findMany({ where: { name: f } });
    if (!mentions.length) return null;
    for (const m of mentions) {
      await this.prisma.personMention
        .upsert({ where: { name_day: { name: t, day: m.day } }, create: { name: t, day: m.day }, update: {} })
        .catch(() => undefined);
    }
    await this.prisma.personMention.deleteMany({ where: { name: f } });
    const aliases = await this.peopleAliases();
    aliases[f] = t;
    // re-point any aliases that targeted the old name
    for (const k of Object.keys(aliases)) if (aliases[k] === f) aliases[k] = t;
    await this.setSetting('people.aliases', JSON.stringify(aliases));
    return { merged: mentions.length, from: f, into: t };
  }

  /** Everything ever recorded involving one person: per mention-day, the task lines, story
   *  sentences and notes containing their name (any known spelling). Pure data, no AI. */
  async personDetail(name: string) {
    const canonical = String(name || '').trim();
    if (!canonical) return null;
    const mentions = await this.prisma.personMention.findMany({ where: { name: canonical }, orderBy: { day: 'desc' } });
    if (!mentions.length) return null;
    const aliases = await this.peopleAliases();
    const spellings = [canonical, ...Object.keys(aliases).filter((k) => aliases[k] === canonical)].map((s) => s.toLowerCase());
    const has = (text?: string | null) => !!text && spellings.some((sp) => text.toLowerCase().includes(sp));
    const sentencesWith = (text: string) =>
      text
        .split(/(?<=[.!?。])\s+|\n+/)
        .map((s) => s.trim())
        .filter((s) => s && has(s))
        .map((s) => s.slice(0, 280));

    const days = [] as { day: string; items: { type: 'story' | 'task' | 'note'; text: string }[] }[];
    for (const m of mentions) {
      const [told, tasks, notes] = await Promise.all([
        this.prisma.story.findFirst({ where: { day: m.day }, orderBy: { createdAt: 'desc' } }),
        this.prisma.task.findMany({ where: { day: m.day } }),
        this.prisma.dayNote.findMany({ where: { day: m.day } }),
      ]);
      const items: { type: 'story' | 'task' | 'note'; text: string }[] = [];
      if (told?.rawText) for (const s of sentencesWith(told.rawText)) items.push({ type: 'story', text: s });
      for (const t of tasks) if (has(t.title) || has(t.note)) items.push({ type: 'task', text: `${t.title}${t.status === 'done' ? ' ✓' : ''}` });
      for (const n of notes) if (has(n.text)) items.push({ type: 'note', text: n.text.slice(0, 280) });
      days.push({ day: m.day, items });
    }
    return {
      name: canonical,
      mentions: mentions.length,
      firstSeen: mentions[mentions.length - 1].day,
      lastSeen: mentions[0].day,
      otherSpellings: Object.keys(aliases).filter((k) => aliases[k] === canonical),
      days,
    };
  }

  /** Extract people's names from the user's own story (tiny Haiku call, idempotent per name+day). */
  async extractPeople(day: string, storyText?: string | null): Promise<void> {
    const text = (storyText || '').trim();
    if (text.length < 20) return;
    const prompt =
      `Extract the names of real PEOPLE mentioned in this diary entry / task list. Rules:\n` +
      `- People only — NOT companies, products, apps, places, AI assistants/tools (Claude, ChatGPT…), or the diary's author himself (Sandeep/"I").\n` +
      `- Use the name as written (e.g. "Srikar", "Kishore"). Max 10.\n` +
      `- If none, return an empty list.\n` +
      `Respond with ONLY JSON: {"people":["Name", ...]}\n\nDIARY ENTRY / TASKS:\n${text.slice(0, 3000)}`;
    const raw = (await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, prompt, 200, 'people-extract'))?.trim() || '';
    let names: string[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.people)) names = json.people;
    } catch {
      return;
    }
    const aliases = await this.peopleAliases();
    for (const n of names.slice(0, 10)) {
      let name = String(n || '').trim().slice(0, 60);
      if (!name || name.length < 2) continue;
      name = aliases[name] || name; // learned spellings from merges
      await this.prisma.personMention
        .upsert({ where: { name_day: { name, day } }, create: { name, day }, update: {} })
        .catch(() => undefined);
    }
  }

  /** Aggregated people view: mention counts, first/last seen, and who's fading from his stories. */
  async peopleOverview() {
    const rows = await this.prisma.personMention.findMany({ orderBy: { day: 'asc' } });
    const today = this.dayKey(await this.tz());
    const cutoff = this.dayAdd(today, -14);
    const map = new Map<string, { name: string; mentions: number; firstSeen: string; lastSeen: string }>();
    for (const r of rows) {
      const e = map.get(r.name);
      if (e) {
        e.mentions++;
        e.lastSeen = r.day > e.lastSeen ? r.day : e.lastSeen;
        e.firstSeen = r.day < e.firstSeen ? r.day : e.firstSeen;
      } else map.set(r.name, { name: r.name, mentions: 1, firstSeen: r.day, lastSeen: r.day });
    }
    const people = [...map.values()]
      .map((p) => ({ ...p, fading: p.mentions >= 2 && p.lastSeen < cutoff }))
      .sort((a, b) => b.mentions - a.mentions || b.lastSeen.localeCompare(a.lastSeen));
    return { people, count: people.length };
  }

  // ---- Story of the Year (the book itself) ----

  private shapeYearStory(y: any) {
    return { year: y.year, title: y.title, text: y.text, partial: y.partial, createdAt: y.createdAt, updatedAt: y.updatedAt };
  }

  async getYearStory(year: string) {
    const row = await this.prisma.yearStory.findUnique({ where: { year } });
    return row ? this.shapeYearStory(row) : null;
  }

  /** Weave the year's monthly chapters into the Story of the Year. Partial = "year so far". */
  async generateYearStory(year: string, force = false) {
    if (!/^\d{4}$/.test(year)) return null;
    if (!force) {
      const existing = await this.prisma.yearStory.findUnique({ where: { year } });
      if (existing && !existing.partial) return this.shapeYearStory(existing); // the final book is never silently rewritten
    }
    const chapters = await this.prisma.monthStory.findMany({ where: { month: { gte: `${year}-01`, lte: `${year}-12` } }, orderBy: { month: 'asc' } });
    if (!chapters.length) return null;
    const today = this.dayKey(await this.tz());
    const partial = today.slice(0, 4) === year; // generated during the year = a "so far" draft

    const chapterBlocks = chapters.map((c: any) => `=== ${c.month}${c.title ? ` — ${c.title}` : ''} ===\n${c.text.slice(0, 2600)}`);
    const tmpl = await this.prompts.get('story.year');
    const prompt =
      `${tmpl}\n\n` +
      `THE YEAR: ${year}${partial ? ` (year SO FAR — chapters through ${chapters[chapters.length - 1].month}; the year is still running)` : ''}\n\n` +
      chapterBlocks.join('\n\n');

    const cfg = await this.storyModel();
    const raw = (await this.llm.completeWith(cfg, prompt, 3500, 'story-of-year'))?.trim() || '';
    let text = raw;
    let title: string | null = null;
    let parsed = false;
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (json?.story) {
        text = String(json.story).trim();
        parsed = true;
      }
      if (json?.title) title = String(json.title).trim().slice(0, 120);
    } catch {
      /* keep prose */
    }
    // Guard: a model "reply" asking for more material must never be saved as the story.
    if (!parsed && /\b(i need|could you (share|provide)|please (share|provide)|remaining .*chapters)\b/i.test(text)) return null;
    if (!text) return null;

    const row = await this.prisma.yearStory.upsert({
      where: { year },
      create: { year, title, text, partial },
      update: { title, text, partial },
    });
    if (!partial) await this.memory.enqueue(`Story of the Year — ${year}${title ? ` — ${title}` : ''}\n\n${text}`, { title: `Story of the Year ${year}`, tags: ['activity'] }).catch(() => undefined);
    return this.shapeYearStory(row);
  }

  /** On Jan 1 (after 01:00 local, once last December's chapter exists), write the previous year's final book. */
  async yearTick(): Promise<void> {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    if (!today.endsWith('-01-01') || this.localHM(tz) < '01:00') return;
    const prevYear = String(Number(today.slice(0, 4)) - 1);
    const existing = await this.prisma.yearStory.findUnique({ where: { year: prevYear } });
    if (existing && !existing.partial) return;
    if (!(await this.prisma.monthStory.findUnique({ where: { month: `${prevYear}-12` } }))) return; // wait for December's chapter first
    const tried = (await this.prisma.setting.findUnique({ where: { key: 'story.yearTry' } }))?.value;
    if (tried === today) return;
    await this.setSetting('story.yearTry', today);
    await this.generateYearStory(prevYear, true).catch(() => undefined);
  }

  // ---- predictive (suggested) tasks for tomorrow ----

  private shapeSuggestion(s: any) {
    return { id: s.id, forDay: s.forDay, title: s.title, category: s.category, reason: s.reason, status: s.status, createdAt: s.createdAt };
  }

  /** Predict tasks FOR `targetDay`, reading the PREVIOUS day's story + tasks. Replaces prior pending picks.
   *  (Suggestions for the 9th come from the 8th's Story of the Day.) */
  async generateSuggestions(targetDay: string) {
    const sourceDay = this.dayAdd(targetDay, -1);
    const forDay = targetDay;
    const [dayStory, told, dayTasks] = await Promise.all([
      this.prisma.dayStory.findUnique({ where: { day: sourceDay } }),
      this.prisma.story.findFirst({ where: { day: sourceDay }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { day: sourceDay } }),
    ]);

    const openTasks = dayTasks.filter((t) => t.status !== 'done');
    const doneList = dayTasks.filter((t) => t.status === 'done').map((t) => `✓ ${t.title}`);
    const openList = openTasks.map((t) => `○ ${t.title}${(t.progress || 0) > 0 ? ` (${t.progress}% done)` : ''}${t.rolloverCount ? ` [carried ${t.rolloverCount}d]` : ''}`);
    const narrative = dayStory?.text || told?.rawText || '';

    const tmpl = await this.prompts.get('tasks.predict');
    const prompt =
      `${tmpl}\n\n` +
      `=== TODAY (${sourceDay}) ===\n` +
      `Story of the day:\n${narrative.slice(0, 2500) || '(none)'}\n\n` +
      `Finished today:\n${doneList.join('\n') || '(none)'}\n\n` +
      `ALREADY ON HIS LIST (do NOT suggest these — they roll over automatically):\n${openList.join('\n') || '(none)'}\n\n` +
      `Suggest only NEW, forward-looking tasks for TOMORROW (${forDay}).`;

    const raw = (await this.llm.completeWith(await this.storyModel(), prompt, 900, 'suggested-tasks'))?.trim() || '';
    let suggestions: { title: string; category?: string; reason?: string }[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.tasks)) suggestions = json.tasks;
    } catch {
      /* ignore — no suggestions this round */
    }
    // Safety net: drop anything that overlaps an existing open/carried task (the model sometimes still echoes
    // the backlog, often slightly reworded). Compare by significant-word overlap, not exact text.
    const sig = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 3));
    const openSets = openTasks.map((t) => sig(t.title)).filter((set) => set.size > 0);
    const isDuplicate = (title: string) => {
      const n = sig(title);
      if (!n.size) return false;
      return openSets.some((o) => {
        const inter = [...n].filter((w) => o.has(w)).length;
        const minSize = Math.min(n.size, o.size);
        return minSize >= 2 ? inter / minSize >= 0.6 : inter >= 1; // most key words shared ⇒ same task
      });
    };
    suggestions = suggestions.filter((s) => s?.title?.trim() && !isDuplicate(s.title)).slice(0, 6);
    if (!suggestions.length) return [];

    // Replace previous *pending* picks for that day (keep ones the user already added/dismissed).
    await this.prisma.suggestedTask.deleteMany({ where: { forDay, status: 'pending' } });
    const created = [];
    for (const s of suggestions) {
      const row = await this.prisma.suggestedTask.create({
        data: {
          forDay,
          title: String(s.title).trim().slice(0, 160),
          category: s.category ? String(s.category).trim().slice(0, 40) : null,
          reason: s.reason ? String(s.reason).trim().slice(0, 240) : null,
        },
      });
      created.push(this.shapeSuggestion(row));
    }
    return created;
  }

  /** Pending suggestions for a day (defaults to today — made from last night's story). */
  async listSuggestions(forDay?: string) {
    const tz = await this.tz();
    const day = forDay && /^\d{4}-\d{2}-\d{2}$/.test(forDay) ? forDay : this.dayKey(tz);
    const rows = await this.prisma.suggestedTask.findMany({ where: { forDay: day, status: 'pending' }, orderBy: { createdAt: 'asc' } });
    return { forDay: day, suggestions: rows.map((r) => this.shapeSuggestion(r)) };
  }

  /** Approve a suggestion → create the real task on its day. */
  async addSuggestion(id: string) {
    const s = await this.prisma.suggestedTask.findUnique({ where: { id } });
    if (!s || s.status !== 'pending') return null;
    const task = await this.prisma.task.create({
      data: { title: s.title, category: s.category, priority: 'medium', day: s.forDay },
    });
    await this.prisma.suggestedTask.update({ where: { id }, data: { status: 'added' } });
    return { ok: true, taskId: task.id, forDay: s.forDay };
  }

  async dismissSuggestion(id: string) {
    await this.prisma.suggestedTask.update({ where: { id }, data: { status: 'dismissed' } }).catch(() => null);
    return { ok: true };
  }

  // ---- agentic personality engine ----
  private readonly PERSONALITY_MIN_DAYS = 10;
  private readonly PERSONALITY_EVERY_MS = 3 * 24 * 60 * 60 * 1000; // every 3 days

  /** Distinct days the user has actually engaged (dumped, told a story, or finished a task). */
  async daysCovered(): Promise<number> {
    const [dumps, stories, doneTasks] = await Promise.all([
      this.prisma.brainDump.findMany({ select: { day: true } }),
      this.prisma.story.findMany({ select: { day: true } }),
      this.prisma.task.findMany({ where: { status: 'done' }, select: { day: true } }),
    ]);
    const set = new Set<string>();
    for (const r of [...dumps, ...stories, ...doneTasks]) if (r.day) set.add(r.day);
    return set.size;
  }

  /** Re-run the personality read every 3 days once there's enough data. */
  async personalityTick(): Promise<void> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'personality.lastRun' } });
    if (row?.value) {
      const last = new Date(row.value).getTime();
      if (Number.isFinite(last) && Date.now() - last < this.PERSONALITY_EVERY_MS) return;
    }
    if ((await this.daysCovered()) < this.PERSONALITY_MIN_DAYS) return;
    await this.regeneratePersonality().catch(() => undefined);
  }

  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /** The agentic read: gather evidence (DB + memory), respect prior validations, ask the Honest-coach model. */
  async regeneratePersonality() {
    const covered = await this.daysCovered();
    await this.setSetting('personality.lastRun', new Date().toISOString());
    if (covered < this.PERSONALITY_MIN_DAYS) {
      return this.getPersonality();
    }

    const [dash, stories, summaries, prior] = await Promise.all([
      this.dashboard(30),
      this.prisma.story.findMany({ orderBy: { createdAt: 'desc' }, take: 14 }),
      this.prisma.daySummary.findMany({ orderBy: { day: 'desc' }, take: 14 }),
      this.prisma.personalityInsight.findMany({ where: { status: { not: 'pending' } }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);

    // Agentic step: pull broader context from memory (best-effort).
    let mem = '';
    try {
      const s: any = await this.memory.searchBoth('Sandeep work habits focus follow-through procrastination patterns mood');
      mem = JSON.stringify(s).slice(0, 1500);
    } catch {
      /* ignore */
    }

    const confirmed = prior.filter((p) => p.status === 'confirmed').map((p) => `+ ${p.claim}`);
    const rejected = prior.filter((p) => p.status === 'rejected').map((p) => `- ${p.claim}`);
    const evidence =
      `Window: last ${dash.days} days · ${covered} active days.\n` +
      `Follow-through: ${dash.totals.followThrough}% (${dash.totals.tasksDone}/${dash.totals.tasksTotal} done). Dump streak: ${dash.streak}.\n` +
      `Time by category: ${dash.categoryTime.map((c) => `${c.category} ${c.minutes}m`).join(', ') || 'n/a'}.\n` +
      `Estimate vs actual: estimated ${dash.estimateVsActual.estimated}m, actual ${dash.estimateVsActual.actual}m over ${dash.estimateVsActual.count} tasks.\n` +
      `Recent moods: ${stories.map((s) => s.mood).filter(Boolean).join(', ') || 'n/a'}.\n` +
      `Recent stories (excerpts):\n${stories.map((s) => '• ' + s.rawText.slice(0, 240)).join('\n') || '(none)'}\n` +
      `Recent day-summaries:\n${summaries.map((s) => '• ' + s.text.slice(0, 200)).join('\n') || '(none)'}\n` +
      (mem ? `Memory hits: ${mem}\n` : '');

    const tmpl = await this.prompts.get('daily.personality');
    const prompt =
      `${tmpl}\n` +
      (confirmed.length ? `\nConfirmed about him:\n${confirmed.join('\n')}\n` : '') +
      (rejected.length ? `Rejected (do not repeat):\n${rejected.join('\n')}\n` : '') +
      `\nEVIDENCE:\n${evidence}`;

    const text = await this.llm.completeWith(await this.tasks.getModel(), prompt, 1500, 'personality');
    let parsed: { summary?: string; insights?: { dimension: string; claim: string; evidence?: string }[] } | null = null;
    try {
      parsed = text ? JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) : null;
    } catch {
      parsed = null;
    }
    if (!parsed?.insights?.length) return this.getPersonality();

    const lastGen = (await this.prisma.personalityInsight.findFirst({ orderBy: { generation: 'desc' } }))?.generation || 0;
    const generation = lastGen + 1;
    for (const ins of parsed.insights.slice(0, 8)) {
      if (!ins?.claim?.trim()) continue;
      await this.prisma.personalityInsight.create({
        data: { generation, dimension: String(ins.dimension || 'Pattern').slice(0, 60), claim: String(ins.claim).slice(0, 400), evidence: ins.evidence ? String(ins.evidence).slice(0, 400) : null },
      });
    }
    await this.setSetting('personality.summary', JSON.stringify({ text: parsed.summary || '', daysCovered: covered, generation, generatedAt: new Date().toISOString() }));
    // Index the portrait so it deepens over time (stamped "activity" → never re-imported by SuperMemory sync).
    await this.memory.enqueue(`Personality portrait of Sandeep\n\n${parsed.summary || ''}\n\n${parsed.insights.map((i) => `${i.dimension}: ${i.claim}`).join('\n')}`, { title: 'Personality portrait', tags: ['activity'] }).catch(() => undefined);
    return this.getPersonality();
  }

  async getPersonality() {
    const covered = await this.daysCovered();
    const sumRow = await this.prisma.setting.findUnique({ where: { key: 'personality.summary' } });
    let summary: any = null;
    try {
      summary = sumRow?.value ? JSON.parse(sumRow.value) : null;
    } catch {
      /* ignore */
    }
    const lastGen = (await this.prisma.personalityInsight.findFirst({ orderBy: { generation: 'desc' } }))?.generation || 0;
    const insights = lastGen
      ? await this.prisma.personalityInsight.findMany({ where: { generation: lastGen }, orderBy: { createdAt: 'asc' } })
      : [];
    const lastRun = (await this.prisma.setting.findUnique({ where: { key: 'personality.lastRun' } }))?.value || null;
    return {
      daysCovered: covered,
      minDays: this.PERSONALITY_MIN_DAYS,
      unlocked: covered >= this.PERSONALITY_MIN_DAYS,
      summary: summary?.text || null,
      generation: lastGen,
      generatedAt: summary?.generatedAt || null,
      lastRun,
      insights: insights.map((i) => ({ id: i.id, dimension: i.dimension, claim: i.claim, evidence: i.evidence, status: i.status })),
    };
  }

  async validateInsight(id: string, status: string) {
    const s = status === 'confirmed' || status === 'rejected' ? status : 'pending';
    const i = await this.prisma.personalityInsight.findUnique({ where: { id } });
    if (!i) return null;
    await this.prisma.personalityInsight.update({ where: { id }, data: { status: s } });
    return { id, status: s };
  }

  /** Aggregate insights over the last `days` (Dashboard). */
  async dashboard(days = 30) {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const span = Math.max(1, Math.min(365, days));
    const start = this.dayAdd(today, -(span - 1));
    const tasks = await this.prisma.task.findMany({ where: { day: { gte: start } } });
    const done = tasks.filter((t) => t.status === 'done');

    // time by category (actual where known, else estimate)
    const catMap: Record<string, number> = {};
    for (const t of done) {
      const c = t.category || 'Uncategorized';
      catMap[c] = (catMap[c] || 0) + (t.actualMin || t.estimateMin || 0);
    }
    const categoryTime = Object.entries(catMap)
      .map(([category, minutes]) => ({ category, minutes }))
      .sort((a, b) => b.minutes - a.minutes);

    // estimate vs actual (only tasks with both)
    const withBoth = done.filter((t) => t.estimateMin && t.actualMin);
    const estimated = withBoth.reduce((s, t) => s + (t.estimateMin || 0), 0);
    const actual = withBoth.reduce((s, t) => s + (t.actualMin || 0), 0);

    // per-day done/total for the bar strip
    const perDay: { day: string; done: number; total: number }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = this.dayAdd(today, -i);
      perDay.push({ day: d, done: done.filter((t) => t.day === d).length, total: tasks.filter((t) => t.day === d).length });
    }

    // brain-dump streak (consecutive days ending today or yesterday)
    const dumpDays = new Set((await this.prisma.brainDump.findMany({ select: { day: true } })).map((d) => d.day));
    let streak = 0;
    let cur = dumpDays.has(today) ? today : this.dayAdd(today, -1);
    while (dumpDays.has(cur)) {
      streak++;
      cur = this.dayAdd(cur, -1);
    }

    // follow-through trend: last 7 days vs the 7 before (drives the home KPI arrow)
    const ftBetween = (from: string, to: string) => {
      const win = tasks.filter((t) => t.day && t.day >= from && t.day <= to);
      const d = win.filter((t) => t.status === 'done').length;
      return win.length ? Math.round((d / win.length) * 100) : null;
    };

    return {
      days: span,
      totals: { tasksTotal: tasks.length, tasksDone: done.length, followThrough: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0 },
      followTrend: { week: ftBetween(this.dayAdd(today, -6), today), prevWeek: ftBetween(this.dayAdd(today, -13), this.dayAdd(today, -7)) },
      minutesSpent: done.reduce((s, t) => s + (t.actualMin || 0), 0),
      categoryTime,
      estimateVsActual: { estimated, actual, count: withBoth.length },
      streak,
      perDay,
    };
  }

  /** Per-day done/total counts across a range, for the calendar heatmap. */
  async calendar(months = 3) {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const span = Math.max(28, Math.min(370, Math.round(months * 31)));
    const start = this.dayAdd(today, -(span - 1));
    const tasks = await this.prisma.task.findMany({ where: { day: { gte: start } } });
    const dumps = new Set((await this.prisma.brainDump.findMany({ where: { day: { gte: start } }, select: { day: true } })).map((d) => d.day));
    const stories = new Set((await this.prisma.story.findMany({ where: { day: { gte: start } }, select: { day: true } })).map((d) => d.day));
    // Pending suggested tasks land on FUTURE days (e.g. tomorrow) — count them per day so the calendar can flag them.
    const suggRows = await this.prisma.suggestedTask.findMany({ where: { status: 'pending' }, select: { forDay: true } });
    const suggested: Record<string, number> = {};
    for (const s of suggRows) suggested[s.forDay] = (suggested[s.forDay] || 0) + 1;
    const byDay: Record<string, { done: number; total: number }> = {};
    for (const t of tasks) {
      const k = t.day || '';
      if (!k) continue;
      byDay[k] = byDay[k] || { done: 0, total: 0 };
      byDay[k].total++;
      if (t.status === 'done') byDay[k].done++;
    }
    const all = new Set([...Object.keys(byDay), ...dumps, ...stories, ...Object.keys(suggested)]);
    const end = [today, ...Object.keys(suggested)].sort().slice(-1)[0]; // extend to the latest suggested day (e.g. tomorrow)
    return {
      start,
      end,
      days: [...all].sort().map((day) => ({
        day,
        done: byDay[day]?.done || 0,
        total: byDay[day]?.total || 0,
        dumped: dumps.has(day),
        story: stories.has(day),
        suggested: suggested[day] || 0,
      })),
    };
  }

  /** Everything for the Activity screen for a given day (defaults to today). */
  async activity(dayInput?: string) {
    const tz = await this.tz();
    const day = dayInput && /^\d{4}-\d{2}-\d{2}$/.test(dayInput) ? dayInput : this.dayKey(tz);
    const [timeline, st, story, summary, dayStory] = await Promise.all([
      this.feed(day, tz),
      this.stats(day),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.daySummary.findUnique({ where: { day } }),
      this.prisma.dayStory.findUnique({ where: { day } }),
    ]);
    return {
      day,
      isToday: day === this.dayKey(tz),
      stats: st,
      story: story ? this.shapeStory(story) : null,
      summary: summary ? this.shapeSummary(summary) : null,
      dayStory: dayStory ? this.shapeDayStory(dayStory) : null,
      timeline,
    };
  }
}
