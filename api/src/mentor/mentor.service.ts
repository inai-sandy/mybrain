import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { TasksService } from '../tasks/tasks.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const MENTOR_AT = '23:59'; // runs just after the Story of the Day (23:58)
const DEFAULT_MENTOR_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };
const DERIVE_EVERY_MS = 3 * 24 * 60 * 60 * 1000;

@Injectable()
export class MentorService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit() {
    this.tick = setInterval(() => this.nightlyTick().catch(() => undefined), 60_000);
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  // ---- time helpers ----
  private async tz(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'tasks.tz' } });
    return row?.value || DEFAULT_TZ;
  }
  private dayKey(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }
  private dayAdd(day: string, n: number): string {
    const d = new Date(day + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  private localHM(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    } catch {
      return d.toISOString().slice(11, 16);
    }
  }

  // ---- model picker ----
  async mentorModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'mentor.llm' } });
    if (!row) return DEFAULT_MENTOR_MODEL;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : DEFAULT_MENTOR_MODEL;
    } catch {
      return DEFAULT_MENTOR_MODEL;
    }
  }
  async setMentorModel(provider: string, model: string) {
    const cfg = this.llm.agentConfig(provider, model);
    const value = JSON.stringify(cfg);
    await this.prisma.setting.upsert({ where: { key: 'mentor.llm' }, create: { key: 'mentor.llm', value }, update: { value } });
    return cfg;
  }
  async listModels() {
    return this.tasks.listModels();
  }

  /** Model that writes the Sunday weekly review (own picker; falls back to the Mentor model). */
  async weeklyModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'weekly.llm' } });
    if (!row) return this.mentorModel();
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : this.mentorModel();
    } catch {
      return this.mentorModel();
    }
  }
  async setWeeklyModel(provider: string, model: string) {
    const cfg = this.llm.agentConfig(provider, model);
    await this.setSetting('weekly.llm', JSON.stringify(cfg));
    return cfg;
  }

  // ---- focus areas ----
  private shapeFocus(f: any) {
    return { id: f.id, title: f.title, description: f.description, source: f.source, status: f.status, createdAt: f.createdAt };
  }

  /** Active + proposed focus areas (archived hidden). */
  async listFocusAreas() {
    const rows = await this.prisma.focusArea.findMany({ where: { status: { not: 'archived' } }, orderBy: { createdAt: 'asc' } });
    const all = rows.map((r) => this.shapeFocus(r));
    return { active: all.filter((f) => f.status === 'active'), proposed: all.filter((f) => f.status === 'proposed') };
  }

  async createFocusArea(title: string, description?: string) {
    const t = String(title || '').trim().slice(0, 120);
    if (!t) return null;
    const row = await this.prisma.focusArea.create({ data: { title: t, description: description ? String(description).trim().slice(0, 400) : null, source: 'user', status: 'active' } });
    return this.shapeFocus(row);
  }

  async updateFocusArea(id: string, data: { title?: string; description?: string; status?: string }) {
    const f = await this.prisma.focusArea.findUnique({ where: { id } });
    if (!f) return null;
    const status = data.status && ['proposed', 'active', 'archived'].includes(data.status) ? data.status : f.status;
    const row = await this.prisma.focusArea.update({
      where: { id },
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 120) : f.title,
        description: data.description !== undefined ? (data.description ? String(data.description).trim().slice(0, 400) : null) : f.description,
        status,
      },
    });
    return this.shapeFocus(row);
  }

  /** Read recent Stories of the Day + task patterns and propose focus areas (added as "proposed" for the user to confirm). */
  async deriveFocusAreas() {
    const [dayStories, stories, recentTasks] = await Promise.all([
      this.prisma.dayStory.findMany({ orderBy: { day: 'desc' }, take: 21 }),
      this.prisma.story.findMany({ orderBy: { createdAt: 'desc' }, take: 21 }),
      this.prisma.task.findMany({ orderBy: { createdAt: 'desc' }, take: 400 }),
    ]);

    // Task pattern: where his time/effort actually goes, by category (a strong signal of real direction).
    const catCount: Record<string, number> = {};
    const catMin: Record<string, number> = {};
    for (const t of recentTasks) {
      const c = (t.category || 'Uncategorized').trim();
      catCount[c] = (catCount[c] || 0) + 1;
      catMin[c] = (catMin[c] || 0) + (t.actualMin || t.estimateMin || 0);
    }
    const catLines = Object.keys(catCount)
      .sort((a, b) => catMin[b] - catMin[a])
      .slice(0, 8)
      .map((c) => `- ${c}: ${catCount[c]} tasks, ~${catMin[c]}m`);

    const corpus =
      `Recent Stories of the Day:\n${dayStories.map((s) => `• (${s.day}) ${s.text.slice(0, 400)}`).join('\n') || '(none yet)'}\n\n` +
      `Recent told stories:\n${stories.map((s) => `• ${s.rawText.slice(0, 240)}`).join('\n') || '(none)'}\n\n` +
      `Where his task effort goes (by category):\n${catLines.join('\n') || '(no task data yet)'}\n\n` +
      `Days of data available: ${dayStories.length} stories. If this is small (under ~5), be especially cautious and propose at most one focus area, or none.`;

    const tmpl = await this.prompts.get('mentor.focus');
    const raw = (await this.llm.completeWith(await this.mentorModel(), `${tmpl}\n\n${corpus}`, 900, 'mentor-focus'))?.trim() || '';
    let proposed: { title: string; description?: string }[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.focusAreas)) proposed = json.focusAreas;
    } catch {
      /* ignore */
    }
    proposed = proposed.filter((p) => p?.title?.trim()).slice(0, 3);

    // A fresh "Suggest" replaces the previous un-confirmed proposals (they're just pending ideas),
    // and we only avoid duplicating focus areas the user has actually CONFIRMED (active).
    await this.prisma.focusArea.deleteMany({ where: { status: 'proposed', source: 'derived' } });
    const active = (await this.prisma.focusArea.findMany({ where: { status: 'active' } })).map((f) => f.title.toLowerCase().trim());
    const created = [];
    for (const p of proposed) {
      const title = String(p.title).trim().slice(0, 120);
      if (active.includes(title.toLowerCase())) continue; // already a confirmed focus
      const row = await this.prisma.focusArea.create({ data: { title, description: p.description ? String(p.description).trim().slice(0, 400) : null, source: 'derived', status: 'proposed' } });
      created.push(this.shapeFocus(row));
    }
    await this.setSetting('mentor.lastDerive', new Date().toISOString());
    return created;
  }

  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  // ---- daily mentor read ----
  private shapeMentorDay(m: any) {
    return { day: m.day, adherenceScore: m.adherenceScore, moodScore: m.moodScore, guidance: m.guidance, createdAt: m.createdAt };
  }

  /** One day's read + the previous existing read's score (for the "vs yesterday" delta). */
  async getDay(day: string) {
    const row = await this.prisma.mentorDay.findUnique({ where: { day } });
    if (!row) return null;
    const prev = await this.prisma.mentorDay.findFirst({ where: { day: { lt: day } }, orderBy: { day: 'desc' } });
    return { ...this.shapeMentorDay(row), prev: prev ? { day: prev.day, adherenceScore: prev.adherenceScore } : null };
  }

  /** Compare the day to the active focus areas, write guidance + an adherence score. */
  async runMentorDay(day: string, force = false) {
    if (!force) {
      const existing = await this.prisma.mentorDay.findUnique({ where: { day } });
      if (existing) return this.shapeMentorDay(existing);
    }
    const [dayStory, told, dayTasks, focus, recent] = await Promise.all([
      this.prisma.dayStory.findUnique({ where: { day } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.task.findMany({ where: { day } }),
      this.prisma.focusArea.findMany({ where: { status: 'active' }, orderBy: { createdAt: 'asc' } }),
      // strictly PRIOR days, so a re-run never reads its own earlier draft as "yesterday"
      this.prisma.mentorDay.findMany({ where: { day: { lt: day } }, orderBy: { day: 'desc' }, take: 4 }),
    ]);

    const narrative = dayStory?.text || told?.rawText || '';
    const personalNarrative = (dayStory as any)?.personalText || '';
    if (!narrative && !dayTasks.length) return null; // nothing to mentor on

    const doneList = dayTasks.filter((t) => t.status === 'done').map((t) => `✓ ${t.title}${(t as any).sphere === 'personal' ? ' [personal]' : ''}`);
    const openList = dayTasks.filter((t) => t.status !== 'done').map((t) => `○ ${t.title}${(t.progress || 0) > 0 ? ` (${t.progress}%)` : ''}${(t as any).sphere === 'personal' ? ' [personal]' : ''}`);
    const focusLines = focus.map((f) => `- ${f.title}${f.description ? `: ${f.description}` : ''}`);
    const yesterday = recent[0] || null; // most recent prior read
    const recentGuide = [...recent].reverse().map((m) => `(${m.day}, score ${m.adherenceScore}) ${m.guidance.slice(0, 300)}`);

    const tmpl = await this.prompts.get('mentor.guidance');
    const bigger = await this.trendBlock(day).catch(() => '');
    const prompt =
      `${tmpl}\n\n` +
      `=== HIS FOCUS AREAS ===\n${focusLines.join('\n') || '(none set yet — give general direction and infer what matters)'}\n\n` +
      `=== TODAY (${day}) ===\n` +
      `Story of the Day (professional):\n${narrative.slice(0, 2200) || '(none)'}\n\n` +
      (personalNarrative ? `Story of the Day (personal/family):\n${personalNarrative.slice(0, 1800)}\n\n` : '') +
      ((dayStory as any)?.proMoodScore != null || (dayStory as any)?.personalMoodScore != null ? `Moods — work: ${(dayStory as any)?.proMoodScore ?? '–'}/100, personal: ${(dayStory as any)?.personalMoodScore ?? '–'}/100.\n\n` : '') +
      `Finished:\n${doneList.join('\n') || '(none)'}\n\nStill open:\n${openList.join('\n') || '(none)'}\n\n` +
      `=== YESTERDAY ===\n${yesterday ? `Score: ${yesterday.adherenceScore}/100 (${yesterday.day}). Your note to him was:\n${yesterday.guidance.slice(0, 600)}` : '(no prior read — this is your first note to him)'}\n\n` +
      `=== YOUR EARLIER NOTES ===\n${recentGuide.join('\n') || '(none)'}` +
      (bigger ? `\n\n${bigger}` : '');

    const raw = (await this.llm.completeWith(await this.mentorModel(), prompt, 1200, 'mentor-guidance'))?.trim() || '';
    let guidance = raw;
    let adherenceScore = dayStory?.moodScore ?? 50;
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (json?.guidance) guidance = String(json.guidance).trim();
      if (Number.isFinite(json?.adherenceScore)) adherenceScore = Math.max(0, Math.min(100, Math.round(Number(json.adherenceScore))));
    } catch {
      /* keep prose as guidance */
    }
    if (!guidance) return null;

    const row = await this.prisma.mentorDay.upsert({
      where: { day },
      create: { day, adherenceScore, moodScore: dayStory?.moodScore ?? null, guidance },
      update: { adherenceScore, moodScore: dayStory?.moodScore ?? null, guidance },
    });
    // Flag it for the nightly Telegram push.
    await this.setSetting('telegram.pushMentor', day).catch(() => undefined);
    return this.shapeMentorDay(row);
  }

  // ---- weekly review (Sunday night) ----

  /** Monday of the week containing `day` (weeks run Mon..Sun). */
  weekStartOf(day: string): string {
    const d = new Date(day + 'T12:00:00Z');
    const dow = d.getUTCDay(); // 0=Sun..6=Sat
    return this.dayAdd(day, dow === 0 ? -6 : 1 - dow);
  }

  private shapeWeekly(w: any) {
    let stats: any = null;
    try {
      stats = w.stats ? JSON.parse(w.stats) : null;
    } catch {
      /* ignore */
    }
    return { weekStart: w.weekStart, weekEnd: this.dayAdd(w.weekStart, 6), text: w.text, pattern: w.pattern, experiment: w.experiment, stats, createdAt: w.createdAt };
  }

  async listWeekly(limit = 12) {
    const rows = await this.prisma.weeklyReview.findMany({ orderBy: { weekStart: 'desc' }, take: Math.max(1, Math.min(52, limit)) });
    return { reviews: rows.map((w) => this.shapeWeekly(w)), count: await this.prisma.weeklyReview.count() };
  }

  /** Plain-code week numbers — the grounding data for the review and the nightly trend block. */
  private async weekStats(weekStart: string) {
    const days: string[] = Array.from({ length: 7 }, (_, i) => this.dayAdd(weekStart, i));
    const [tasks, mentorDays, dayStories] = await Promise.all([
      this.prisma.task.findMany({ where: { day: { gte: days[0], lte: days[6] } } }),
      this.prisma.mentorDay.findMany({ where: { day: { gte: days[0], lte: days[6] } } }),
      this.prisma.dayStory.findMany({ where: { day: { gte: days[0], lte: days[6] } } }),
    ]);
    const done = tasks.filter((t) => t.status === 'done');
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
    const perDay = days.map((d) => ({ day: d, done: done.filter((t) => t.day === d).length, total: tasks.filter((t) => t.day === d).length }));
    const withTasks = perDay.filter((p) => p.total > 0);
    const best = withTasks.length ? withTasks.reduce((a, b) => (b.done / b.total > a.done / a.total ? b : a)) : null;
    const nums = (xs: any[]) => xs.filter((x): x is number => Number.isFinite(x as number));
    return {
      weekStart,
      tasksTotal: tasks.length,
      tasksDone: done.length,
      followThrough: tasks.length ? Math.round((done.length / tasks.length) * 100) : null,
      minutesSpent: done.reduce((s, t) => s + (t.actualMin || 0), 0),
      avgAdherence: avg(mentorDays.map((m) => m.adherenceScore)),
      avgMood: avg(nums(dayStories.map((s) => s.moodScore))),
      avgWorkMood: avg(nums(dayStories.map((s: any) => s.proMoodScore ?? s.moodScore))),
      avgPersonalMood: avg(nums(dayStories.map((s: any) => s.personalMoodScore))),
      daysWithStory: dayStories.length,
      bestDay: best?.day || null,
    };
  }

  /** Write the Sunday weekly review for the week starting `weekStart` (Mon..Sun). */
  async generateWeeklyReview(weekStart: string, force = false) {
    if (!force) {
      const existing = await this.prisma.weeklyReview.findUnique({ where: { weekStart } });
      if (existing) return this.shapeWeekly(existing);
    }
    const days: string[] = Array.from({ length: 7 }, (_, i) => this.dayAdd(weekStart, i));
    const [stats, prevStats, summaries, dayStories, focus, prevReview] = await Promise.all([
      this.weekStats(weekStart),
      this.weekStats(this.dayAdd(weekStart, -7)),
      this.prisma.daySummary.findMany({ where: { day: { gte: days[0], lte: days[6] } }, orderBy: { day: 'asc' } }),
      this.prisma.dayStory.findMany({ where: { day: { gte: days[0], lte: days[6] } }, orderBy: { day: 'asc' } }),
      this.prisma.focusArea.findMany({ where: { status: 'active' } }),
      this.prisma.weeklyReview.findFirst({ where: { weekStart: { lt: weekStart } }, orderBy: { weekStart: 'desc' } }),
    ]);
    if (!summaries.length && !dayStories.length && !stats.tasksTotal) return null; // empty week — nothing to review

    const today = this.dayKey(await this.tz());
    const dayLines = days.map((d) => {
      if (d > today) return `• ${d}: (in the future — has not happened yet; do NOT treat as missed)`;
      const sum = summaries.find((s) => s.day === d);
      const ds = dayStories.find((s) => s.day === d);
      const bits = [sum?.text?.replace(/\s+/g, ' ').slice(0, 280), ds?.moodScore != null ? `mood ${ds.moodScore}` : null, (ds as any)?.proMoodScore != null ? `work ${(ds as any).proMoodScore}` : null, (ds as any)?.personalMoodScore != null ? `personal ${(ds as any).personalMoodScore}` : null].filter(Boolean);
      return `• ${d}: ${bits.join(' · ') || '(no record)'}`;
    });

    // People: who appeared this week, who is fading (pure data — the mentor decides if it matters)
    const mentions = await this.prisma.personMention.findMany().catch(() => [] as any[]);
    const inWeek = new Map<string, number>();
    const lastSeen = new Map<string, string>();
    const total = new Map<string, number>();
    for (const m of mentions) {
      total.set(m.name, (total.get(m.name) || 0) + 1);
      if (!lastSeen.has(m.name) || m.day > lastSeen.get(m.name)!) lastSeen.set(m.name, m.day);
      if (m.day >= days[0] && m.day <= days[6]) inWeek.set(m.name, (inWeek.get(m.name) || 0) + 1);
    }
    const fading = [...total.entries()]
      .filter(([n, c]) => c >= 2 && lastSeen.get(n)! < this.dayAdd(weekStart, -14))
      .map(([n]) => `${n} (last mentioned ${lastSeen.get(n)})`);
    const peopleBlock =
      inWeek.size || fading.length
        ? `\n=== PEOPLE IN HIS STORIES ===\nThis week: ${[...inWeek.keys()].join(', ') || '(no one mentioned)'}\nFading (2+ weeks unmentioned): ${fading.join('; ') || '(none)'}\n`
        : '';

    const tmpl = await this.prompts.get('mentor.weekly');
    const prompt =
      `${tmpl}\n\n` +
      `=== THE WEEK (${weekStart} .. ${days[6]}) ===\nToday is ${today}.\n${dayLines.join('\n')}\n${peopleBlock}\n` +
      `=== NUMBERS ===\nThis week: ${JSON.stringify(stats)}\nLast week: ${JSON.stringify(prevStats)}\n\n` +
      `=== HIS FOCUS AREAS ===\n${focus.map((f) => `- ${f.title}`).join('\n') || '(none set)'}\n\n` +
      `=== LAST WEEK'S REVIEW ===\n${prevReview ? `${prevReview.text.slice(0, 700)}\nPattern then: ${prevReview.pattern || '-'}\nExperiment then: ${prevReview.experiment || '-'}` : '(this is the first weekly review)'}`;

    const raw = (await this.llm.completeWith(await this.weeklyModel(), prompt, 1400, 'weekly-review'))?.trim() || '';
    let text = raw;
    let pattern: string | null = null;
    let experiment: string | null = null;
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (json?.review) text = String(json.review).trim();
      if (json?.pattern) pattern = String(json.pattern).trim().slice(0, 300);
      if (json?.experiment) experiment = String(json.experiment).trim().slice(0, 300);
    } catch {
      /* keep prose */
    }
    if (!text) return null;

    const row = await this.prisma.weeklyReview.upsert({
      where: { weekStart },
      create: { weekStart, text, pattern, experiment, stats: JSON.stringify(stats) },
      update: { text, pattern, experiment, stats: JSON.stringify(stats) },
    });
    await this.setSetting('telegram.pushWeekly', weekStart).catch(() => undefined);
    return this.shapeWeekly(row);
  }

  /** Trend context for the nightly read: 4 weekly adherence/mood averages + the latest review. Pure numbers, no AI cost. */
  private async trendBlock(day: string): Promise<string> {
    const lines: string[] = [];
    const thisMonday = this.weekStartOf(day);
    for (let w = 3; w >= 0; w--) {
      const ws = this.dayAdd(thisMonday, -7 * w);
      const s = await this.weekStats(ws);
      if (!s.tasksTotal && s.avgAdherence === null) continue;
      lines.push(`Week of ${ws}: follow-through ${s.followThrough ?? '–'}%, avg adherence ${s.avgAdherence ?? '–'}, avg mood ${s.avgMood ?? '–'} (work ${s.avgWorkMood ?? '–'} / personal ${s.avgPersonalMood ?? '–'}), ${s.daysWithStory}/7 stories told`);
    }
    const latest = await this.prisma.weeklyReview.findFirst({ orderBy: { weekStart: 'desc' } });
    let block = lines.length ? `=== THE BIGGER PICTURE (4-week numbers) ===\n${lines.join('\n')}` : '';
    if (latest) {
      block += `\n\n=== YOUR LATEST WEEKLY REVIEW (${latest.weekStart}) ===\nPattern you named: ${latest.pattern || '-'}\nThe running experiment: ${latest.experiment || '-'} — if today's data speaks to it, say so.`;
    }
    return block;
  }

  /** Everything the Mentor screen needs: focus areas, latest guidance, and the trend series. */
  async overview(days = 30) {
    const tz = await this.tz();
    const today = this.dayKey(tz);
    const span = Math.max(7, Math.min(120, days));
    const start = this.dayAdd(today, -(span - 1));
    const [focus, rows] = await Promise.all([
      this.listFocusAreas(),
      this.prisma.mentorDay.findMany({ where: { day: { gte: start } }, orderBy: { day: 'asc' } }),
    ]);
    const trend = rows.map((m) => ({ day: m.day, adherence: m.adherenceScore, mood: m.moodScore }));
    const latest = rows.length ? this.shapeMentorDay(rows[rows.length - 1]) : null;
    const avgAdherence = rows.length ? Math.round(rows.reduce((s, m) => s + m.adherenceScore, 0) / rows.length) : null;
    return { focusAreas: focus, latest, trend, avgAdherence, days: span };
  }

  // ---- nightly ----

  /** (Re)write a day's read unless one already exists that reflects the FINAL day (written after its
   *  Story of the Day). A daytime "Get guidance now" must never block the end-of-day read, and a
   *  missed 23:59 window (deploy/restart) gets caught up the next day. */
  async ensureFreshRead(day: string): Promise<void> {
    // A sealed day's read is FINAL — closeDay wrote it; never silently re-run it here.
    if (await this.prisma.dayClose.findUnique({ where: { day } })) return;
    const [read, story] = await Promise.all([
      this.prisma.mentorDay.findUnique({ where: { day } }),
      this.prisma.dayStory.findUnique({ where: { day } }),
    ]);
    if (read && (!story || new Date(read.updatedAt) >= new Date(story.createdAt))) return; // already fresh
    await this.runMentorDay(day, true).catch(() => undefined);
  }

  async nightlyTick(): Promise<void> {
    const tz = await this.tz();
    const day = this.dayKey(tz);

    if (this.localHM(tz) >= MENTOR_AT) {
      // End of day: make sure there are focus areas to mentor against, then write tonight's read.
      const haveAny = await this.prisma.focusArea.count({ where: { status: { not: 'archived' } } });
      const lastDerive = (await this.prisma.setting.findUnique({ where: { key: 'mentor.lastDerive' } }))?.value;
      const dueToDerive = !lastDerive || Date.now() - new Date(lastDerive).getTime() > DERIVE_EVERY_MS;
      if (!haveAny || dueToDerive) await this.deriveFocusAreas().catch(() => undefined);
      await this.ensureFreshRead(day);
    } else {
      // Catch-up: yesterday's read was missed (restart at 23:59) or is stale (a daytime manual
      // run wrote it before the Story of the Day existed) — fix it now.
      await this.ensureFreshRead(this.dayAdd(day, -1));
    }

    // Sunday 21:45: the weekly review (covers Mon..today). Any other time: catch up LAST week's
    // review if the window was missed (restart, server down) and that week has data.
    // The once-a-day guard stops a failed/empty generation from re-calling the LLM every minute.
    const tried = (await this.prisma.setting.findUnique({ where: { key: 'mentor.weeklyTry' } }))?.value;
    if (tried === day) return;
    const dow = new Date(day + 'T12:00:00Z').getUTCDay();
    if (dow === 0 && this.localHM(tz) >= '21:45') {
      await this.setSetting('mentor.weeklyTry', day);
      await this.generateWeeklyReview(this.weekStartOf(day)).catch(() => undefined);
    } else {
      const lastWeek = this.dayAdd(this.weekStartOf(day), -7);
      if (!(await this.prisma.weeklyReview.findUnique({ where: { weekStart: lastWeek } }))) {
        await this.setSetting('mentor.weeklyTry', day);
        await this.generateWeeklyReview(lastWeek).catch(() => undefined);
      }
    }
  }
}
