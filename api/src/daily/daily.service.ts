import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { TasksService } from '../tasks/tasks.service';
import { PromptsService } from '../prompts/prompts.service';
import { looseJsonParse, narrativeField } from '../common/llm-json';
import { matchContact, contactSpellings, norm as normName } from '../contacts/person-identity';
import { MentorService } from '../mentor/mentor.service';
import { MentalModelService } from '../mind/mentalmodel.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const SUMMARY_AT = '21:30'; // local time the auto day-summary fires
const STORY_AT = '23:58'; // local time the nightly Story of the Day fires
const MORNING_WRAP_AT = '10:00'; // local time the morning auto-wrap-up runs (BEA-467)
const DEFAULT_STORY_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };
const DONE_EXTRACT_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }; // tiny job: pull finished tasks from the story

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
    private readonly mentor: MentorService,
    private readonly mind: MentalModelService,
  ) {}

  onModuleInit() {
    this.tick = setInterval(() => {
      this.summaryTick().catch(() => undefined);
      this.storyTick().catch(() => undefined);
      this.morningWrapTick().catch(() => undefined);
      this.lifecycleTick().catch(() => undefined);
      this.monthTick().catch(() => undefined);
      this.yearTick().catch(() => undefined);
      this.personalityTick().catch(() => undefined);
      this.repairTick().catch(() => undefined);
    }, 60_000);
  }

  private lastRepairAt = 0;
  /** Throttled repair for sealed-but-incomplete days (a close whose background story/summary failed). */
  async repairTick(): Promise<void> {
    if (Date.now() - this.lastRepairAt < 10 * 60_000) return; // at most every 10 minutes
    this.lastRepairAt = Date.now();
    await this.repairSealedDays();
  }

  /** A day can be sealed (dayClose row exists) but missing its story/summary if the close's background
   *  jobs failed — and the periodic ticks skip closed days, so it never self-heals. Regenerate the
   *  missing narrative for recently-closed days that have no story yet. (BEA-827) */
  async repairSealedDays(): Promise<number> {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const from = this.dayAdd(today, -3);
    const closes = await this.prisma.dayClose.findMany({ where: { day: { gte: from, lte: today } }, select: { day: true } });
    if (!closes.length) return 0;
    const days = closes.map((c) => c.day);
    const haveStory = new Set((await this.prisma.dayStory.findMany({ where: { day: { in: days } }, select: { day: true } })).map((s) => s.day));
    let repaired = 0;
    for (const day of days) {
      if (haveStory.has(day)) continue; // already complete
      await this.generateSummary(day, true).catch(() => undefined);
      await this.generateDayStory(day, true).catch(() => undefined);
      await this.mentor.runMentorDay(day, true).catch(() => undefined);
      repaired++;
    }
    return repaired;
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

  async submitStory(rawText: string, source = 'app', mood?: string, forDay?: string, noWrap = false) {
    const text = (rawText || '').trim();
    if (!text) return null;
    const today = this.dayKey(await this.tz());
    // Telling a past day's story (e.g. the morning after) is allowed; the future is not.
    const day = forDay && /^\d{4}-\d{2}-\d{2}$/.test(forDay) && forDay <= today ? forDay : today;
    const existing = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const row = existing
      ? await this.prisma.story.update({ where: { id: existing.id }, data: { rawText: text, source, mood: mood ?? existing.mood } })
      : await this.prisma.story.create({ data: { day, rawText: text, source, mood: mood || null } });
    // Index his own words so "My life" chat + Explore can answer from them ("what was I worried about in May?").
    // Linked to the Story row (refType 'story') so rewriting a day REPLACES its doc instead of duplicating. (BEA-331)
    this.memory
      .indexEntity({
        refType: 'story',
        refId: row.id,
        title: `Your story ${day}`,
        content: `His own story — ${day}${mood ? ` (mood: ${mood})` : ''}\n\n${text}`,
        tags: ['activity', 'story'],
        prevSupermemoryId: (existing as any)?.supermemoryId,
        prevRagId: (existing as any)?.ragId,
      })
      .catch(() => undefined);
    // If you tell a PAST day's story (the morning after), wrap that day up NOW — don't wait for the
    // 10:00 job. (BEA-469) noWrap (the EMO merge, BEA-981): Emo never closes a day — you do.
    const wrapping = !noWrap && day < today && !(await this.isClosed(day));
    if (wrapping) void this.wrapDayNow(day).catch(() => undefined); // fire-and-forget: closeDay runs Mentor + Lab (~a minute)
    // If that day's Story of the Day was already written, rewrite it around the user's own words (skip if wrapping — closeDay re-weaves).
    const woven = await this.prisma.dayStory.findUnique({ where: { day } });
    if (woven && !wrapping) this.generateDayStory(day, true).catch(() => undefined);
    return { ...this.shapeStory(row), rewriting: !!woven, wrapped: wrapping };
  }

  /** Wrap up a specific past day right now (its story is in) — closeDay = summary + story + Mentor + Lab + rollover + seal. (BEA-469) */
  async wrapDayNow(day: string): Promise<boolean> {
    if (await this.isClosed(day)) return false;
    await this.closeDay(day, true, 'you told the story').catch(() => undefined);
    return true;
  }

  /** (Re)index stories not yet linked into the brain (or all). Idempotent — indexEntity deletes
   *  prior docs first, so re-running never duplicates. (BEA-331) */
  async backfillStories(all = false): Promise<{ stories: number }> {
    const where = all ? {} : { OR: [{ ragId: null }, { supermemoryId: null }] };
    const rows = await this.prisma.story.findMany({ where });
    for (const row of rows) {
      this.memory
        .indexEntity({
          refType: 'story',
          refId: row.id,
          title: `Your story ${row.day}`,
          content: `His own story — ${row.day}${row.mood ? ` (mood: ${row.mood})` : ''}\n\n${row.rawText}`,
          tags: ['activity', 'story'],
          prevSupermemoryId: (row as any).supermemoryId,
          prevRagId: (row as any).ragId,
        })
        .catch(() => undefined);
    }
    return { stories: rows.length };
  }

  private shapeStory(s: any) {
    return { id: s.id, day: s.day, text: s.rawText, source: s.source, mood: s.mood, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  // ---- daily wrap-up: finished tasks from the story + working hours ----

  /** Read the day's story and surface concrete tasks the user MENTIONS having finished but never logged. */
  async doneCandidates(dayInput?: string): Promise<{ day: string; candidates: { title: string; category: string | null }[] }> {
    const tz = await this.tz();
    const day = dayInput && /^\d{4}-\d{2}-\d{2}$/.test(dayInput) ? dayInput : this.dayKey(tz);
    const story = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const text = (story?.rawText || '').trim();
    if (text.length < 15) return { day, candidates: [] };

    const existing = await this.prisma.task.findMany({ where: { day }, select: { title: true } });
    const existingTitles = existing.map((e) => e.title);
    const prompt =
      `From the user's diary entry below, extract the concrete tasks/work they say they DID or FINISHED today.\n` +
      `Return ONLY JSON: {"tasks":[{"title":"short imperative task","category":"optional 1-2 word bucket"}]}.\n` +
      `Rules: only real, completed work — not feelings, not plans, not things they failed to do; short titles; {"tasks":[]} if none.\n` +
      `Do NOT include anything already in this already-logged list:\n${existingTitles.map((t) => `- ${t}`).join('\n') || '(none)'}\n\n` +
      `DIARY:\n${text.slice(0, 4000)}`;
    const raw = (await this.llm.completeWith(DONE_EXTRACT_MODEL, prompt, 500, 'done-extract'))?.trim() || '';
    let list: { title?: string; category?: string }[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.tasks)) list = json.tasks;
    } catch {
      list = [];
    }

    // Drop anything that overlaps an already-logged task (significant-word overlap).
    const sig = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 3));
    const existSets = existingTitles.map((t) => sig(t)).filter((set) => set.size);
    const isDup = (title: string) => {
      const n = sig(title);
      if (!n.size) return false;
      return existSets.some((o) => {
        const inter = [...n].filter((w) => o.has(w)).length;
        const minSize = Math.min(n.size, o.size);
        return minSize >= 2 ? inter / minSize >= 0.6 : inter >= 1;
      });
    };
    const seen = new Set<string>();
    const candidates = list
      .map((t) => ({ title: String(t?.title || '').trim().slice(0, 160), category: t?.category ? String(t.category).trim().slice(0, 40) : null }))
      .filter((t) => t.title && !isDup(t.title) && !seen.has(t.title.toLowerCase()) && seen.add(t.title.toLowerCase()))
      .slice(0, 12);
    return { day, candidates };
  }

  /** Forward to-dos the user mentioned in their story (things still TO DO), to add to the tasks sheet in the flow. (BEA-513) */
  async todoCandidates(dayInput?: string): Promise<{ day: string; todos: { title: string; category: string | null; note: string | null; priority: string }[] }> {
    const tz = await this.tz();
    const day = dayInput && /^\d{4}-\d{2}-\d{2}$/.test(dayInput) ? dayInput : this.dayKey(tz);
    const today = this.dayKey(tz);
    const story = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const text = (story?.rawText || '').trim();
    if (text.length < 15) return { day, todos: [] };

    const existing = await this.prisma.task.findMany({ where: { OR: [{ day }, { day: today }], status: { not: 'done' } }, select: { title: true } });
    const existingTitles = existing.map((e) => e.title);
    const prompt =
      `From the user's diary entry below, extract the concrete things they still NEED or PLAN to do — open to-dos, follow-ups and next actions they mention for the days ahead.\n` +
      `Return ONLY JSON: {"tasks":[{"title":"short imperative task","category":"optional 1-2 word bucket","note":"one line of concrete context or deadline from the diary — omit if none","priority":"high | medium | low"}]}.\n` +
      `Rules: only real forward actions (things to do next) — NOT things they already finished, NOT feelings/reflections; short imperative titles; keep the note to the useful detail the diary gives (who/what/when); {"tasks":[]} if none.\n` +
      `Do NOT include anything already in this open list:\n${existingTitles.map((t) => `- ${t}`).join('\n') || '(none)'}\n\n` +
      `DIARY:\n${text.slice(0, 4000)}`;
    const raw = (await this.llm.completeWith(DONE_EXTRACT_MODEL, prompt, 500, 'todo-extract'))?.trim() || '';
    let list: { title?: string; category?: string; note?: string; priority?: string }[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.tasks)) list = json.tasks;
    } catch {
      list = [];
    }
    const sig = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 3));
    const existSets = existingTitles.map((t) => sig(t)).filter((set) => set.size);
    const isDup = (title: string) => {
      const n = sig(title);
      if (!n.size) return false;
      return existSets.some((o) => {
        const inter = [...n].filter((w) => o.has(w)).length;
        const minSize = Math.min(n.size, o.size);
        return minSize >= 2 ? inter / minSize >= 0.6 : inter >= 1;
      });
    };
    const seen = new Set<string>();
    const todos = list
      .map((t) => ({
        title: String(t?.title || '').trim().slice(0, 160),
        category: t?.category ? String(t.category).trim().slice(0, 40) : null,
        note: t?.note ? String(t.note).trim().slice(0, 500) : null,
        priority: /^(high|medium|low)$/i.test(String(t?.priority)) ? String(t?.priority).toLowerCase() : 'medium',
      }))
      .filter((t) => t.title && !isDup(t.title) && !seen.has(t.title.toLowerCase()) && seen.add(t.title.toLowerCase()))
      .slice(0, 12);
    return { day, todos };
  }

  /** Add the user-approved story to-dos as OPEN tasks (default to today). (BEA-513) */
  async addStoryTodos(todos: { title?: string; category?: string | null; note?: string | null; priority?: string }[]): Promise<{ created: number }> {
    let created = 0;
    for (const t of (todos || []).slice(0, 20)) {
      const r = await this.tasks.create({ title: t.title, category: t.category || undefined, note: t.note || undefined, priority: t.priority || 'medium' });
      if (r) created++;
    }
    return { created };
  }

  /** AI split of the stated working minutes across 3–6 topics, from the story + that day's finished tasks. */
  private async computeWorkedBreakdown(day: string, wm: number): Promise<{ category: string; minutes: number }[] | null> {
    const [story, doneTasks] = await Promise.all([
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { day, status: 'done' }, select: { title: true, category: true } }),
    ]);
    const taskLines = doneTasks.map((t) => `- ${t.title}${t.category ? ` [${t.category}]` : ''}`).join('\n');
    const prompt =
      `The user worked ${wm} minutes today. Split that time across 3–6 simple work categories based on what they actually did.\n` +
      `Base this PRIMARILY on their own Story of the day below (what they describe doing) — that is the source of truth, because they do plenty of work they never log as tasks. Use the finished-task list only as a supporting hint, never as the main basis.\n` +
      `Return ONLY JSON {"breakdown":[{"category":"short label","minutes":N}]} where the minutes sum to about ${wm}.\n\n` +
      `Story of the day (primary source):\n${(story?.rawText || '').slice(0, 3000)}\n\nFinished tasks (supporting hints only):\n${taskLines || '(none logged)'}`;
    const raw = (await this.llm.completeWith(DONE_EXTRACT_MODEL, prompt, 400, 'worked-breakdown'))?.trim() || '';
    let list: { category?: string; minutes?: number }[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.breakdown)) list = json.breakdown;
    } catch {
      return null;
    }
    const cleaned = list
      .map((b) => ({ category: String(b?.category || '').trim().slice(0, 40), minutes: Math.max(0, Math.round(Number(b?.minutes) || 0)) }))
      .filter((b) => b.category && b.minutes > 0)
      .slice(0, 8);
    if (!cleaned.length) return null;
    const sum = cleaned.reduce((s, b) => s + b.minutes, 0) || 1;
    return cleaned.map((b) => ({ category: b.category, minutes: Math.round((b.minutes / sum) * wm) })); // normalise to sum ≈ wm
  }

  /** Everything the wrap-up step needs in one call: finished-task candidates, a suggested hours figure
   *  (from the day's activity span), and the day's still-unfinished tasks for carry-forward. */
  async wrapUpData(dayInput?: string) {
    const tz = await this.tz();
    const day = dayInput && /^\d{4}-\d{2}-\d{2}$/.test(dayInput) ? dayInput : this.dayKey(tz);
    const [{ candidates }, { todos }, feed, open] = await Promise.all([
      this.doneCandidates(day),
      this.todoCandidates(day),
      this.feed(day, tz),
      this.prisma.task.findMany({ where: { day, status: { not: 'done' } }, orderBy: { createdAt: 'asc' }, select: { id: true, title: true } }),
    ]);
    // Suggest hours from the span between the first and last thing the user did in the app that day.
    let suggestedMinutes: number | null = null;
    const times = feed
      .map((e) => new Date(e.at as any).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b);
    if (times.length >= 2) {
      const span = Math.round((times[times.length - 1] - times[0]) / 60000);
      suggestedMinutes = Math.max(30, Math.min(16 * 60, span));
    }
    return { day, candidates, todos, suggestedMinutes, openTasks: open };
  }

  /** Wrap up the day: log the approved finished tasks as DONE, save the stated working minutes,
   *  and carry-forward unfinished tasks (roll to tomorrow / drop). */
  async wrapUp(dayInput: string | undefined, tasks: { title?: string; category?: string | null }[], workedMinutes?: number, roll: string[] = [], drop: string[] = []) {
    const tz = await this.tz();
    const day = dayInput && /^\d{4}-\d{2}-\d{2}$/.test(dayInput) ? dayInput : this.dayKey(tz);
    let created = 0;
    for (const t of (tasks || []).slice(0, 20)) {
      const task = await this.tasks.createDoneTask(String(t?.title || ''), t?.category ?? null, day).catch(() => null);
      if (task) created++;
    }
    let wm: number | null = null;
    if (workedMinutes != null && Number.isFinite(workedMinutes)) {
      wm = Math.max(0, Math.min(24 * 60, Math.round(workedMinutes)));
      const story = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
      if (story) {
        // Split the stated hours across topics (uses the done tasks we just created above).
        const breakdown = wm > 0 ? await this.computeWorkedBreakdown(day, wm).catch(() => null) : null;
        await this.prisma.story
          .update({ where: { id: story.id }, data: { workedMinutes: wm, ...(breakdown && breakdown.length ? { workedBreakdown: JSON.stringify(breakdown) } : {}) } })
          .catch(() => undefined);
      }
    }
    // Carry-forward: roll the chosen unfinished tasks forward, drop the ones the user dropped.
    // Land on max(day+1, today): when wrapping an OLD day, day+1 may already be sealed/past, which
    // would strand the tasks (gone from Today, the "finish yesterday" banner, and all rollover).
    // today is never sealed, so the tasks stay visible and workable. (BEA-781)
    const next = this.dayAdd(day, 1);
    const today = this.dayKey(tz);
    const target = next > today ? next : today;
    let rolled = 0;
    let dropped = 0;
    for (const id of (roll || []).slice(0, 50)) {
      const r = await this.prisma.task.update({ where: { id }, data: { day: target, status: 'open', rolloverCount: { increment: 1 } } }).catch(() => null);
      if (r) rolled++;
    }
    for (const id of (drop || []).slice(0, 50)) {
      const r = await this.prisma.task.delete({ where: { id } }).catch(() => null);
      if (r) dropped++;
    }
    return { day, created, workedMinutes: wm, rolled, dropped };
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
    const [dayTasks, story] = await Promise.all([
      this.prisma.task.findMany({ where: { day } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' }, select: { workedMinutes: true } }),
    ]);
    const done = dayTasks.filter((t) => t.status === 'done');
    const minutesSpent = done.reduce((s, t) => s + (t.actualMin || 0), 0);
    const estimated = dayTasks.reduce((s, t) => s + (t.estimateMin || 0), 0);
    return {
      tasksTotal: dayTasks.length,
      tasksDone: done.length,
      tasksOpen: dayTasks.length - done.length,
      minutesSpent,
      minutesEstimated: estimated,
      // the user-stated working minutes for the day (the real working-hours figure); null if not set
      workedMinutes: story?.workedMinutes ?? null,
      // weighted view: part-done tasks count for their % (a 60% task = 60), done = 100. (BEA-761)
      tasksPartial: dayTasks.filter((t) => t.status !== 'done' && (t.progress || 0) > 0).length,
      progressPct: this.avgProg(dayTasks),
    };
  }

  /** Effective completion of a task, 0–100: a done task is 100, else its part-done progress. (BEA-761) */
  private prog(t: { status: string; progress?: number | null }): number {
    return t.status === 'done' ? 100 : Math.max(0, Math.min(100, t.progress || 0));
  }
  /** Weighted follow-through: the average effective completion across a set of tasks. (BEA-761) */
  private avgProg(list: { status: string; progress?: number | null }[]): number {
    return list.length ? Math.round(list.reduce((s, t) => s + this.prog(t), 0) / list.length) : 0;
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
    // Part-done (30/60) get their own line so the summary credits real progress, not just finished. (BEA-761)
    const partialList = dayTasks.filter((t) => t.status !== 'done' && (t.progress || 0) > 0).map((t) => `◐ ${t.title} — ${t.progress}% done`);
    const openList = dayTasks.filter((t) => t.status !== 'done' && !(t.progress || 0)).map((t) => `○ ${t.title}${t.rolloverCount ? ` [carried ${t.rolloverCount}d]` : ''}`);
    const activityLines = timeline.filter((e) => e.type !== 'task').map((e) => `- ${e.title}`);

    const tmpl = await this.prompts.get('daily.summary');
    const prompt =
      `${tmpl}\n\n` +
      `Tasks done (${st.tasksDone}/${st.tasksTotal} finished, ${st.progressPct}% overall progress, ~${st.minutesSpent}m):\n${doneList.join('\n') || '(none)'}\n\n` +
      `Part done (real progress, not finished):\n${partialList.join('\n') || '(none)'}\n\n` +
      `Still pending:\n${openList.join('\n') || '(none)'}\n\n` +
      `Other activity in the app:\n${activityLines.join('\n') || '(none)'}\n\n` +
      `His story of the day${story?.mood ? ` (mood: ${story.mood})` : ''}:\n${story?.rawText?.slice(0, 2000) || '(not told)'}`;

    const text = (await this.llm.completeWith(await this.summaryModel(), prompt, 900, 'day-summary'))?.trim() || this.fallbackSummary(st, doneList, openList);
    const stats = JSON.stringify(st);
    const row = await this.prisma.daySummary.upsert({
      where: { day },
      create: { day, text, stats },
      update: { text, stats },
    });

    // Day summaries are NO LONGER indexed into memory — the Story of the Day already captures the day,
    // richer, so a separate summary doc was redundant noise. (BEA-551)
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
    // The picker sends an id; agentConfig() resolves 'codex' / 'gemini::<model>' to the right engine.
    const cfg = this.llm.agentConfig(provider, model);
    const value = JSON.stringify(cfg);
    await this.prisma.setting.upsert({ where: { key: 'story.llm' }, create: { key: 'story.llm', value }, update: { value } });
    return cfg;
  }
  /** OpenAI + Anthropic models for the Settings pickers (shared with Tasks). */
  async listModels() {
    return this.tasks.listModels();
  }

  shapeDayStory(s: any) {
    return { day: s.day, text: s.text, personalText: s.personalText ?? null, mood: s.mood, moodScore: s.moodScore, proMoodScore: s.proMoodScore ?? null, personalMoodScore: s.personalMoodScore ?? null, model: s.model, createdAt: s.createdAt, updatedAt: s.updatedAt };
  }

  async getDayStory(day: string) {
    const row = await this.prisma.dayStory.findUnique({ where: { day } });
    return row ? this.shapeDayStory(row) : null;
  }

  /** At 11:58 PM local, write today's Story of the Day (and tomorrow's suggested tasks). If the
   *  late-night window was missed (deploy/restart), catch up on YESTERDAY's story the next day.
   *  A SEALED day is final — never (re)drafted here. Drafts on an open day are provisional (derived). */
  async storyTick(): Promise<void> {
    const tz = await this.tz();
    const day = this.dayKey(tz);
    if (this.localHM(tz) >= STORY_AT) {
      if (await this.isClosed(day)) return;
      if (await this.prisma.dayStory.findUnique({ where: { day } })) return;
      await this.generateDayStory(day).catch(() => undefined);
      // Tonight's story (day) drives tomorrow's suggestions (day + 1).
      await this.generateSuggestions(this.dayAdd(day, 1)).catch(() => undefined);
    } else {
      const y = this.dayAdd(day, -1);
      if (await this.isClosed(y)) return;
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

  // ---- day lifecycle: open → sealed (the "Close the day" engine) ----

  private readonly SEAL_AFTER_DAYS = 2; // a day stays open through today + the next day, then auto-seals (~48h)

  async isClosed(day: string): Promise<boolean> {
    return !!(await this.prisma.dayClose.findUnique({ where: { day } }));
  }

  /** Close (finalize/seal) a day: regenerate its summary → story → mentor read → next-day suggestions
   *  IN ORDER, then roll its still-open tasks forward to today, then mark it sealed. One unified act. */
  async closeDay(day: string, auto = false, reason?: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const tz = await this.tz();
    const today = this.dayKey(tz);
    // 1. SEAL FIRST — the fast, essential work, so the request returns immediately and the day actually closes
    //    even if the LLM artifacts below are slow. (BEA-541: the 4 LLM calls used to run first and time out
    //    the request before the seal, leaving the day un-closed.)
    // Snapshot the day's still-open tasks BEFORE the rollover moves them off the day — this is the
    // Lab's "skipped" signal, which was always empty because rollDayForward ran first. (BEA-808)
    const skippedSnapshot = day < today ? await this.prisma.task.findMany({ where: { day, status: { not: 'done' } } }) : [];
    // Roll the day's genuine leftovers forward: a past day → today; closing today → tomorrow.
    const target = day < today ? today : this.dayAdd(day, 1);
    const rolled = (await this.tasks.rollDayForward(day, target)).rolled;
    // Seal it — its artifacts are now "final" (provisional is derived from this row's absence).
    await this.prisma.dayClose.upsert({ where: { day }, create: { day, auto }, update: { auto } });
    // Run-log so the user sees every wrap with its time + why it happened. (BEA-470)
    await this.prisma.mindRun.create({ data: { kind: 'close', day, detail: `Wrapped up ${day}${reason ? ` — ${reason}` : auto ? ' (automatic)' : ''}` } }).catch(() => undefined);
    // 2. Generate the heavy narrative + verdict in the BACKGROUND, in dependency order, then let the Lab
    //    reflect. The UI already tells the user this takes about a minute. Fire-and-forget.
    void (async () => {
      await this.generateSummary(day, true).catch(() => undefined);
      await this.generateDayStory(day, true).catch(() => undefined);
      await this.mentor.runMentorDay(day, true).catch(() => undefined);
      await this.generateSuggestions(this.dayAdd(day, 1)).catch(() => undefined);
      await this.mind.learnDay(day, skippedSnapshot).catch(() => undefined); // the Lab reflects once the day is complete, with the pre-rollover skipped set (BEA-458, BEA-808)
    })().catch(() => undefined);
    return { day, closed: true, auto, rolled };
  }

  /** The morning checkpoint (BEA-467): once a day at 10:00 local, wrap up yesterday if its story is in.
   *  Strict — it runs ONCE per day; if the story isn't in yet, it nudges and waits for tomorrow's 10:00. */
  async morningWrapTick(): Promise<void> {
    const tz = await this.tz();
    if (this.localHM(tz) < MORNING_WRAP_AT) return; // only at/after 10:00 local
    const today = this.dayKey(tz);
    const seen = await this.prisma.setting.findUnique({ where: { key: 'daily.lastMorningWrap' } });
    if (seen?.value === today) return; // once per day
    // Mark done ONLY after a successful pass — setting the guard first meant a failed wrap left
    // yesterday permanently unclosed (no summary, no Lab learn) and never retried. (BEA-826)
    await this.wrapYesterday(today);
    await this.setSetting('daily.lastMorningWrap', today);
  }

  /** Close yesterday if its story is in; otherwise flag a single Telegram reminder. Clock-independent. (BEA-467) */
  async wrapYesterday(today: string): Promise<{ wrapped: boolean; reminded: boolean }> {
    const y = this.dayAdd(today, -1);
    if (await this.isClosed(y)) return { wrapped: false, reminded: false }; // already wrapped (e.g. closed by hand)
    const told = await this.prisma.story.findFirst({ where: { day: y } });
    if (told) {
      await this.closeDay(y, true, '10:00 check — your story was in').catch(() => undefined); // summary + story + Mentor + Lab + rollover + seal
      return { wrapped: true, reminded: false };
    }
    // No story yet at the checkpoint — at most one gentle nudge (and only if the user wants it). (BEA-527)
    const prefs = await this.getNudgePrefs().catch(() => ({ mentorPush: true, storyReminder: true }));
    if (!prefs.storyReminder) return { wrapped: false, reminded: false }; // pull-only — they'll tell the story when they're ready
    await this.setSetting('telegram.pushStoryReminder', y).catch(() => undefined);
    await this.prisma.mindRun.create({ data: { kind: 'reminder', day: y, detail: `${y}: story not in by 10:00 — reminded you on Telegram` } }).catch(() => undefined);
    return { wrapped: false, reminded: true };
  }

  /** Auto-seal abandoned days once per local day: any day older than the grace window that still has
   *  content and was never closed gets finalized so the weekly/book pipeline never stalls. */
  async lifecycleTick(): Promise<void> {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const scan = await this.prisma.setting.findUnique({ where: { key: 'daily.lastSealScan' } });
    if (scan?.value === today) return; // once per day is enough — sealability only changes at day boundaries
    await this.setSetting('daily.lastSealScan', today);
    const cutoff = this.dayAdd(today, -this.SEAL_AFTER_DAYS); // seal days <= cutoff
    const closed = new Set((await this.prisma.dayClose.findMany({ select: { day: true } })).map((c) => c.day));
    // candidate days with content: any told story or any task, on a day at/over the cutoff and not closed
    const [storyDays, taskDays] = await Promise.all([
      this.prisma.story.findMany({ where: { day: { lte: cutoff } }, select: { day: true } }),
      this.prisma.task.findMany({ where: { day: { lte: cutoff } }, select: { day: true } }),
    ]);
    const days = [...new Set([...storyDays, ...taskDays].map((r) => r.day).filter((d): d is string => !!d))]
      .filter((d) => !closed.has(d))
      .sort();
    for (const d of days) await this.closeDay(d, true, 'auto-sealed (was left open)').catch(() => undefined);
  }

  /** Past days that are still open and have something to finalize — drives the "finish yesterday" prompt. */
  async openDays() {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const closed = new Set((await this.prisma.dayClose.findMany({ select: { day: true } })).map((c) => c.day));
    const tasks = await this.prisma.task.findMany({ where: { day: { lt: today } }, select: { day: true, status: true } });
    const stories = await this.prisma.story.findMany({ where: { day: { lt: today } }, select: { day: true } });
    const byDay: Record<string, { day: string; openTasks: number; totalTasks: number; hasStory: boolean }> = {};
    for (const t of tasks) {
      if (!t.day || closed.has(t.day)) continue;
      const e = (byDay[t.day] = byDay[t.day] || { day: t.day, openTasks: 0, totalTasks: 0, hasStory: false });
      e.totalTasks++;
      if (t.status !== 'done') e.openTasks++;
    }
    for (const s of stories) {
      if (!s.day || closed.has(s.day)) continue;
      (byDay[s.day] = byDay[s.day] || { day: s.day, openTasks: 0, totalTasks: 0, hasStory: false }).hasStory = true;
    }
    const list = Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day));
    return { days: list, count: list.length };
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
    const { text: rawText, model: usedModel } = await this.llm.completeWithModel(cfg, prompt, 2000, 'story-of-day');
    const raw = (rawText || '').trim();
    const storyModelLabel = usedModel || cfg.model;
    let text = raw;
    let personalText: string | null = null;
    let mood: string | null = told?.mood || null;
    let moodScore: number | null = null;
    let proMoodScore: number | null = null;
    let personalMoodScore: number | null = null;
    const score = (v: any): number | null => (Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(Number(v)))) : null);
    // Robust parse — never store a raw JSON blob if the model emits messy JSON (BEA-884).
    const parsed = looseJsonParse(raw);
    if (parsed?.professional?.story || parsed?.personal?.story) {
      // two-sphere shape: text = professional (or personal alone if work was silent)
      text = String(parsed.professional?.story || parsed.personal?.story || '').trim();
      personalText = parsed.professional?.story && parsed.personal?.story ? String(parsed.personal.story).trim() : null;
      proMoodScore = score(parsed.professional?.moodScore);
      personalMoodScore = score(parsed.personal?.moodScore);
    } else {
      text = narrativeField(raw, 'story'); // single-story JSON or plain prose — never a blob
    }
    if (parsed?.mood) mood = String(parsed.mood).slice(0, 40);
    moodScore = score(parsed?.moodScore);
    if (!text) text = this.fallbackSummary(st, doneList, openList);

    const row = await this.prisma.dayStory.upsert({
      where: { day },
      create: { day, text, personalText, mood, moodScore, proMoodScore, personalMoodScore, model: storyModelLabel },
      update: { text, personalText, mood, moodScore, proMoodScore, personalMoodScore, model: storyModelLabel },
    });
    await this.prisma.mindRun.create({ data: { kind: 'story', day, detail: `Wrote your Story of the Day for ${day}` } }).catch(() => undefined); // run-log (BEA-470)

    // Store the Story of the Day, REPLACING any prior version (re-weaves when the user's story changes). (BEA-342)
    this.memory
      .indexEntity({ refType: 'daystory', refId: row.id, title: `Story of the Day ${day}`, content: `Story of the Day — ${day}\n\n${text}${personalText ? `\n\nPERSONAL LIFE:\n${personalText}` : ''}`, tags: ['activity', 'story'], prevSupermemoryId: (row as any).supermemoryId, prevRagId: (row as any).ragId })
      .catch(() => undefined);
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

    const cfg = await this.bookModel();
    const raw = (await this.llm.completeWith(cfg, prompt, 2200, 'story-of-month'))?.trim() || '';
    // Robust parse — never store a raw {"title":…,"story":…} blob if JSON hiccups (BEA-884).
    const text = narrativeField(raw, 'story');
    const parsed = looseJsonParse(raw);
    const title: string | null = parsed?.title ? String(parsed.title).trim().slice(0, 120) : null;
    if (!text) return null;

    const row = await this.prisma.monthStory.upsert({
      where: { month },
      create: { month, title, text },
      update: { title, text },
    });
    this.memory
      .indexEntity({ refType: 'monthstory', refId: row.id, title: `Story of the Month ${month}`, content: `Story of the Month — ${month}${title ? ` — ${title}` : ''}\n\n${text}`, tags: ['activity'], prevSupermemoryId: (row as any).supermemoryId, prevRagId: (row as any).ragId })
      .catch(() => undefined);
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

  // ---- per-feature model pickers (book + people) ----

  private async pickerModel(key: string, fallback: LlmConfig): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    if (!row) return fallback;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : fallback;
    } catch {
      return fallback;
    }
  }
  private async setPickerModel(key: string, provider: string, model: string) {
    const cfg = this.llm.agentConfig(provider, model);
    await this.setSetting(key, JSON.stringify(cfg));
    return cfg;
  }

  /** Model that writes the monthly chapters + Story of the Year (own picker; falls back to the Story model). */
  async bookModel(): Promise<LlmConfig> {
    return this.pickerModel('book.llm', await this.storyModel());
  }
  async setBookModel(provider: string, model: string) {
    return this.setPickerModel('book.llm', provider, model);
  }

  /** Model that extracts people from the day (own picker; defaults to Haiku — it's a tiny job). */
  async peopleModel(): Promise<LlmConfig> {
    return this.pickerModel('people.llm', { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' });
  }
  async setPeopleModel(provider: string, model: string) {
    return this.setPickerModel('people.llm', provider, model);
  }

  /** Model that writes the daily summary (own picker; until set it follows the Tasks engine). */
  async summaryModel(): Promise<LlmConfig> {
    return this.pickerModel('summary.llm', await this.tasks.getModel());
  }
  async setSummaryModel(provider: string, model: string) {
    return this.setPickerModel('summary.llm', provider, model);
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
    const contacts = await this.contactsShaped();
    const contact = matchContact(contacts, canonical);
    const aliases = await this.peopleAliases();
    // Every spelling of this one person: the contact's name+aliases, plus taught story spellings. (BEA-763)
    const spellSet = new Set<string>();
    const add = (s: string) => { const t = String(s || '').trim(); if (t) spellSet.add(t); };
    add(canonical);
    if (contact) contactSpellings(contact).forEach(add);
    Object.keys(aliases).filter((k) => aliases[k] === canonical).forEach(add);
    const spellings = [...spellSet];
    const rows = await this.prisma.personMention.findMany({ where: { name: { in: spellings } }, orderBy: { day: 'desc' } });
    if (!rows.length) return null;
    const uniqDays = [...new Set(rows.map((r) => r.day))].sort((a, b) => b.localeCompare(a)); // desc, de-duped across spellings
    const mentions = uniqDays.map((day) => ({ day }));
    // Word-boundary match (like tasks.byPerson) — a plain includes() made "Ram" match "program",
    // "Ana" match "banana", etc., pulling unrelated history onto the person page. (BEA-810)
    const spellingRes = spellings.map((s) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
    const has = (text?: string | null) => !!text && spellingRes.some((re) => re.test(text));
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
      name: contact?.name || canonical,
      mentions: mentions.length,
      firstSeen: mentions[mentions.length - 1].day,
      lastSeen: mentions[0].day,
      otherSpellings: spellings.filter((s) => normName(s) !== normName(contact?.name || canonical)),
      contactId: contact?.id || null, // link this person to a saved Contact if one matches (BEA-762/763)
      days,
    };
  }

  /** All contacts, with aliases parsed — for the person↔contact matcher. (BEA-763) */
  private async contactsShaped(): Promise<{ id: string; name: string; aliases: string[] }[]> {
    const rows = await this.prisma.contact.findMany({ select: { id: true, name: true, aliases: true } });
    return rows.map((c) => ({ id: c.id, name: c.name, aliases: this.jarr((c as any).aliases) }));
  }
  private jarr(s?: string | null): string[] {
    try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  private async contactIdFor(name: string): Promise<string | null> {
    return matchContact(await this.contactsShaped(), name)?.id || null;
  }

  /** Extract people's names from the user's own story (tiny Haiku call, idempotent per name+day). */
  async extractPeople(day: string, storyText?: string | null): Promise<void> {
    const text = (storyText || '').trim();
    if (text.length < 20) return;
    const tmplP = await this.prompts.get('people.extract');
    const prompt = `${tmplP}\n\nDIARY ENTRY / TASKS:\n${text.slice(0, 3000)}`;
    const raw = (await this.llm.completeWith(await this.peopleModel(), prompt, 200, 'people-extract'))?.trim() || '';
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
    // Attach the saved-Contact id where a person's name matches a contact's name OR alias. (BEA-762/763)
    const contacts = await this.contactsShaped();
    const people = [...map.values()]
      .map((p) => ({ ...p, fading: p.mentions >= 2 && p.lastSeen < cutoff, contactId: matchContact(contacts, p.name)?.id || null }))
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

    const cfg = await this.bookModel();
    const raw = (await this.llm.completeWith(cfg, prompt, 3500, 'story-of-year'))?.trim() || '';
    // Robust parse — never store a raw {"title":…,"story":…} blob (BEA-884).
    const parsedJson = looseJsonParse(raw);
    const text = narrativeField(raw, 'story');
    const title: string | null = parsedJson?.title ? String(parsedJson.title).trim().slice(0, 120) : null;
    const parsed = !!(parsedJson && typeof parsedJson.story === 'string' && parsedJson.story.trim());
    // Guard: a model "reply" asking for more material must never be saved as the story.
    if (!parsed && /\b(i need|could you (share|provide)|please (share|provide)|remaining .*chapters)\b/i.test(text)) return null;
    if (!text) return null;

    const row = await this.prisma.yearStory.upsert({
      where: { year },
      create: { year, title, text, partial },
      update: { title, text, partial },
    });
    if (!partial)
      this.memory
        .indexEntity({ refType: 'yearstory', refId: row.id, title: `Story of the Year ${year}`, content: `Story of the Year — ${year}${title ? ` — ${title}` : ''}\n\n${text}`, tags: ['activity'], prevSupermemoryId: (row as any).supermemoryId, prevRagId: (row as any).ragId })
        .catch(() => undefined);
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

  /** The Home "Today" card (BEA-518): one focus, the top suggested action, and the key lever. */
  async todayCard() {
    const tz = await this.tz();
    const day = this.dayKey(tz);
    const [focusList, sug, chain, latestMentor] = await Promise.all([
      this.mentor.listFocusAreas().catch(() => ({ active: [] as { title: string }[], proposed: [] })),
      this.prisma.suggestedTask.findFirst({ where: { forDay: { gte: day }, status: 'pending' }, orderBy: [{ forDay: 'asc' }, { createdAt: 'asc' }] }),
      this.prisma.mindChain.findFirst({ where: { status: 'active', NOT: { validated: 'refuted' } }, orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }] }),
      this.prisma.mentorDay.findFirst({ orderBy: { day: 'desc' }, select: { guidance: true } }),
    ]);
    const focus = focusList.active?.[0]?.title || (latestMentor?.guidance ? latestMentor.guidance.split(/[.\n]/)[0].trim().slice(0, 160) : null);
    const suggestion = sug ? { id: sug.id, title: sug.title, reason: sug.reason } : null;
    const lever = chain ? { goal: chain.goal, lever: chain.lever } : null;
    return { focus, suggestion, lever };
  }

  /** Predict tasks FOR `targetDay`, reading the PREVIOUS day's story + tasks. Replaces prior pending picks.
   *  (Suggestions for the 9th come from the 8th's Story of the Day.) */
  async generateSuggestions(targetDay: string) {
    const sourceDay = this.dayAdd(targetDay, -1);
    const forDay = targetDay;
    const [dayStory, told, dayTasks, labDigest, focus] = await Promise.all([
      this.prisma.dayStory.findUnique({ where: { day: sourceDay } }),
      this.prisma.story.findFirst({ where: { day: sourceDay }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { day: sourceDay } }),
      this.mind.summaryForMentor().catch(() => ''), // About Me + findings + the Situation LEVERS (BEA-517)
      this.mentor.listFocusAreas().catch(() => ({ active: [] as { title: string; description?: string | null }[], proposed: [] })),
    ]);

    const openTasks = dayTasks.filter((t) => t.status !== 'done');
    const doneList = dayTasks.filter((t) => t.status === 'done').map((t) => `✓ ${t.title}`);
    const openList = openTasks.map((t) => `○ ${t.title}${(t.progress || 0) > 0 ? ` (${t.progress}% done)` : ''}${t.rolloverCount ? ` [carried ${t.rolloverCount}d]` : ''}`);
    const narrative = dayStory?.text || told?.rawText || '';
    const focusLines = (focus?.active || []).map((f) => `- ${f.title}${f.description ? `: ${f.description}` : ''}`);

    const tmpl = await this.prompts.get('tasks.predict');
    const prompt =
      `${tmpl}\n\n` +
      (labDigest ? `=== WHAT I KNOW ABOUT HIM (use this — ESPECIALLY THE LEVERS) ===\n${labDigest}\n\n` : '') +
      (focusLines.length ? `=== HIS CURRENT FOCUS AREAS ===\n${focusLines.join('\n')}\n\n` : '') +
      `=== TODAY (${sourceDay}) ===\n` +
      `Story of the day:\n${narrative.slice(0, 2500) || '(none)'}\n\n` +
      `Finished today:\n${doneList.join('\n') || '(none)'}\n\n` +
      `ALREADY ON HIS LIST (do NOT suggest these — they roll over automatically):\n${openList.join('\n') || '(none)'}\n\n` +
      `Suggest only NEW, forward-looking tasks for TOMORROW (${forDay}). PREFER concrete next-actions that move a LEVER (the thing that unblocks a stuck goal) or advance a focus area — not the blocked goals themselves. ` +
      `Where it fits, phrase the task as a tiny if-then plan anchored to an everyday cue — "When <a daily cue like after my morning coffee / after lunch / before I leave work>, I'll <one concrete action>" — this makes it far likelier to actually happen. One action each, plain English. Give each a short plain reason.`;

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
    // Route through the one door so it's indexed + carries a note (the suggestion's own reason). (BEA-955)
    const task = await this.tasks.create({ title: s.title, category: s.category || undefined, priority: 'medium', day: s.forDay, note: s.reason || undefined, auto: true });
    if (!task) return null;
    await this.prisma.suggestedTask.update({ where: { id }, data: { status: 'added' } });
    return { ok: true, taskId: (task as any).id, forDay: s.forDay };
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

  private async getSetting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  /**
   * Proactive-nudge preferences (BEA-527) — "insights pull, not push". The notes themselves are always
   * generated and available in the app; these only control the proactive Telegram pings. Default ON so
   * nothing changes silently for existing users; 'off' makes that surface pull-only.
   */
  async getNudgePrefs(): Promise<{ mentorPush: boolean; storyReminder: boolean }> {
    const [m, s] = await Promise.all([this.getSetting('insights.mentorPush'), this.getSetting('insights.storyReminder')]);
    return { mentorPush: m !== 'off', storyReminder: s !== 'off' };
  }

  async setNudgePrefs(p: { mentorPush?: boolean; storyReminder?: boolean }): Promise<{ mentorPush: boolean; storyReminder: boolean }> {
    if (typeof p.mentorPush === 'boolean') await this.setSetting('insights.mentorPush', p.mentorPush ? 'on' : 'off');
    if (typeof p.storyReminder === 'boolean') await this.setSetting('insights.storyReminder', p.storyReminder ? 'on' : 'off');
    return this.getNudgePrefs();
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
    // The portrait is NO LONGER indexed into memory — it regenerated without replacing, piling up copies,
    // and the Lab/findings already hold this self-knowledge. Kept in Settings, just not in the brain. (BEA-551)
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
    const taskCategoryTime = Object.entries(catMap)
      .map(([category, minutes]) => ({ category, minutes }))
      .sort((a, b) => b.minutes - a.minutes);

    // estimate vs actual (only tasks with both)
    const withBoth = done.filter((t) => t.estimateMin && t.actualMin);
    const estimated = withBoth.reduce((s, t) => s + (t.estimateMin || 0), 0);
    const actual = withBoth.reduce((s, t) => s + (t.actualMin || 0), 0);

    // user-stated working minutes per day (the real working-hours figure) + the AI category split
    const workStories = await this.prisma.story.findMany({ where: { day: { gte: start } }, select: { day: true, workedMinutes: true, workedBreakdown: true } });
    const workedByDay: Record<string, number> = {};
    const breakdownCat: Record<string, number> = {};
    for (const s of workStories) {
      if (s.workedMinutes) workedByDay[s.day] = (workedByDay[s.day] || 0) + s.workedMinutes;
      if (s.workedBreakdown) {
        try {
          for (const b of JSON.parse(s.workedBreakdown) as { category: string; minutes: number }[]) {
            const c = (b?.category || 'Other').trim() || 'Other';
            if (Number.isFinite(b?.minutes)) breakdownCat[c] = (breakdownCat[c] || 0) + Math.max(0, Math.round(b.minutes));
          }
        } catch {
          /* ignore */
        }
      }
    }
    // Prefer the stated-hours split when we have it; otherwise fall back to the task-time estimate.
    const categoryTime = Object.keys(breakdownCat).length
      ? Object.entries(breakdownCat).map(([category, minutes]) => ({ category, minutes })).sort((a, b) => b.minutes - a.minutes)
      : taskCategoryTime;

    // per-day done/total (+ worked minutes) for the bar strips
    const perDay: { day: string; done: number; total: number; worked: number }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = this.dayAdd(today, -i);
      perDay.push({ day: d, done: done.filter((t) => t.day === d).length, total: tasks.filter((t) => t.day === d).length, worked: workedByDay[d] || 0 });
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
      return win.length ? this.avgProg(win) : null; // weighted: part-done counts (BEA-761)
    };

    const minutesWorked = Object.values(workedByDay).reduce((s, x) => s + x, 0);
    // working-hours: this week's total + the prior week's (for the trend arrow), and a working-day average
    const workedBetween = (from: string, to: string) => perDay.filter((p) => p.day >= from && p.day <= to).reduce((s, p) => s + p.worked, 0);
    const weekWorked = workedBetween(this.dayAdd(today, -6), today);
    const prevWeekWorked = workedBetween(this.dayAdd(today, -13), this.dayAdd(today, -7));
    const workedDays = perDay.filter((p) => p.day >= this.dayAdd(today, -6) && p.worked > 0).length;
    const todayWorked = workedByDay[today] || 0;

    return {
      days: span,
      totals: { tasksTotal: tasks.length, tasksDone: done.length, followThrough: this.avgProg(tasks) },
      followTrend: { week: ftBetween(this.dayAdd(today, -6), today), prevWeek: ftBetween(this.dayAdd(today, -13), this.dayAdd(today, -7)) },
      minutesSpent: done.reduce((s, t) => s + (t.actualMin || 0), 0),
      minutesWorked,
      worked: { today: todayWorked, week: weekWorked, prevWeek: prevWeekWorked, window: minutesWorked, weekAvg: workedDays ? Math.round(weekWorked / workedDays) : 0 },
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
    const [timeline, st, story, summary, dayStory, closeRow, openCount] = await Promise.all([
      this.feed(day, tz),
      this.stats(day),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.daySummary.findUnique({ where: { day } }),
      this.prisma.dayStory.findUnique({ where: { day } }),
      this.prisma.dayClose.findUnique({ where: { day } }),
      this.prisma.task.count({ where: { day, status: 'open' } }),
    ]);
    const closed = !!closeRow;
    const isToday = day === this.dayKey(tz);
    return {
      day,
      isToday,
      stats: st,
      story: story ? this.shapeStory(story) : null,
      summary: summary ? this.shapeSummary(summary) : null,
      dayStory: dayStory ? this.shapeDayStory(dayStory) : null,
      timeline,
      closed,
      sealedAuto: closeRow?.auto ?? false,
      // a written verdict on a day that isn't sealed yet is provisional — it finalizes when you close the day
      provisional: !!dayStory && !closed,
      openTaskCount: openCount,
      // a PAST day that isn't closed is still finishable
      needsClosing: !isToday && day < this.dayKey(tz) && !closed && (!!dayStory || !!story || st.tasksTotal > 0),
    };
  }
}
