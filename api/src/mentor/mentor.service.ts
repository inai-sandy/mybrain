import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { looseJsonParse, narrativeField } from '../common/llm-json';
import { MentalModelService } from '../mind/mentalmodel.service';
import { TasksService } from '../tasks/tasks.service';
import { AlertsService } from '../push/alerts.service';
import { pickWeeklyLine, weeklyMessage } from './weekly-line';
import { surfacedWhere } from '../mind/surfacing';

const DEFAULT_TZ = 'Asia/Kolkata';
const MENTOR_AT = '23:59'; // runs just after the Story of the Day (23:58)
/** After an unusable reply, leave that day alone for a while instead of retrying every minute. (BEA-1178) */
const MENTOR_RETRY_AFTER_MS = 30 * 60_000;
const DEFAULT_MENTOR_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };
const DERIVE_EVERY_MS = 3 * 24 * 60 * 60 * 1000;

@Injectable()
export class MentorService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Mentor');
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    private readonly tasks: TasksService,
    private readonly mind: MentalModelService,
    private readonly alerts: AlertsService,
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

    // What the brain has actually learned about him (The Lab) — ground the focus areas in real patterns. (BEA-454)
    const patterns = await this.mind.summaryForMentor().catch(() => '');

    const corpus =
      (patterns ? `What I've learned about him (validated patterns):\n${patterns}\n\n` : '') +
      `Recent Stories of the Day:\n${dayStories.map((s) => `• (${s.day}) ${s.text.slice(0, 400)}`).join('\n') || '(none yet)'}\n\n` +
      `Recent told stories:\n${stories.map((s) => `• ${s.rawText.slice(0, 240)}`).join('\n') || '(none)'}\n\n` +
      `Where his task effort goes (by category):\n${catLines.join('\n') || '(no task data yet)'}\n\n` +
      `Days of data available: ${dayStories.length} stories. If this is small (under ~5), be especially cautious and propose at most one focus area, or none.`;

    const tmpl = await this.prompts.get('mentor.focus');
    const raw = (await this.llm.completeWith(await this.mentorModel(), `${tmpl}\n\n${corpus}`, 2500, 'mentor-focus'))?.trim() || '';
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
  /**
   * `force` used to mean "pay for another one". Three paths passed it — closing a day, re-weaving
   * the Story of the Day, and the 60-second catch-up — so a day that got closed and re-told cost
   * the same essay several times over. Measured: 24 paid runs on 21 July, 4.9/day across 43 days,
   * for something that should run once a night.
   *
   * A day now gets at most TWO paid runs whatever asks — the nightly read, plus one refresh
   * once the Story of the Day lands. `manual` is the single exception: the owner
   * pressing regenerate is a deliberate act, not a side effect. (BEA-1140)
   */
  async runMentorDay(day: string, force = false, manual = false) {
    const existing = await this.prisma.mentorDay.findUnique({ where: { day } });
    // The cheap path: something is already written and nobody asked for a refresh.
    if (existing && !force && !manual) return this.shapeMentorDay(existing);
    if (!manual && (await this.paidToday(day))) {
      return existing ? this.shapeMentorDay(existing) : null; // today's allowance is spent
    }
    const [dayStory, told, dayTasks, focus, recent] = await Promise.all([
      this.prisma.dayStory.findUnique({ where: { day } }),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.tasks.forDay(day), // the day's real record, carried work included (BEA-1018)
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
    const patterns = await this.mind.summaryForMentor().catch(() => ''); // what the brain has learned about him (BEA-454)
    const prompt =
      `${tmpl}\n\n` +
      (patterns ? `=== WHAT I'VE LEARNED ABOUT HIM (validated patterns — use these; when you raise a draining or avoided one, do it with compassion: assume there's a real reason, name it kindly, and pair it with ONE small, doable next step — never shame him or pile on) ===\n${patterns}\n\n` : '') +
      `=== HIS FOCUS AREAS ===\n${focusLines.join('\n') || '(none set yet — give general direction and infer what matters)'}\n\n` +
      `=== TODAY (${day}) ===\n` +
      `Story of the Day (professional):\n${narrative.slice(0, 2200) || '(none)'}\n\n` +
      (personalNarrative ? `Story of the Day (personal/family):\n${personalNarrative.slice(0, 1800)}\n\n` : '') +
      ((dayStory as any)?.proMoodScore != null || (dayStory as any)?.personalMoodScore != null ? `Moods — work: ${(dayStory as any)?.proMoodScore ?? '–'}/100, personal: ${(dayStory as any)?.personalMoodScore ?? '–'}/100.\n\n` : '') +
      `Finished:\n${doneList.join('\n') || '(none)'}\n\nStill open:\n${openList.join('\n') || '(none)'}\n\n` +
      `=== YESTERDAY ===\n${yesterday ? `Score: ${yesterday.adherenceScore}/100 (${yesterday.day}). Your note to him was:\n${yesterday.guidance.slice(0, 600)}` : '(no prior read — this is your first note to him)'}\n\n` +
      `=== YOUR EARLIER NOTES ===\n${recentGuide.join('\n') || '(none)'}` +
      (bigger ? `\n\n${bigger}` : '');

    await this.stampPaid(day); // stamped BEFORE the call, so a failure can't be retried in a loop

    /**
     * The ceiling was 1200 — and 83 of 97 calls in a fortnight came back at exactly 1200, cut off.
     * A cut-off reply is not readable JSON, so `guidance` was empty and the whole thing was thrown
     * away silently, with the call already billed. The owner had NO mentor read at all for 27 and
     * 28 July because of this.
     *
     * The prompt asks for six things and "2-4 short paragraphs", and its input has kept growing —
     * the Lab's validated patterns, the trend block, the personal story, the last four notes. The
     * output grew with it; the ceiling never moved. An unused ceiling costs nothing. (BEA-1178)
     */
    const raw = (await this.llm.completeWith(await this.mentorModel(), prompt, 4000, 'mentor-guidance'))?.trim() || '';
    // Robustly pull guidance + score — never store a raw JSON blob if parsing hiccups (BEA-884).
    // narrativeField now also rescues a note cut off mid-sentence rather than losing it (BEA-1178).
    const guidance = narrativeField(raw, 'guidance');
    const parsed = looseJsonParse(raw);
    let adherenceScore = dayStory?.moodScore ?? 50;
    if (parsed && Number.isFinite(parsed.adherenceScore)) adherenceScore = Math.max(0, Math.min(100, Math.round(Number(parsed.adherenceScore))));
    if (!guidance) {
      // Never silent again. This returned `null` with no log at all, so two nights went missing
      // without a trace anywhere. (BEA-1178)
      this.log.warn(`runMentorDay(${day}): unusable reply (${raw.length} chars) — nothing written`);
      // Keyed PER DAY. One shared slot meant a different day failing (a close, a repair) wiped
      // this day's backoff, and the minute-by-minute retry started again. (BEA-1179)
      await this.setSetting(`mentor.lastFail.${day}`, String(Date.now())).catch(() => undefined);
      return null;
    }

    const row = await this.prisma.mentorDay.upsert({
      where: { day },
      create: { day, adherenceScore, moodScore: dayStory?.moodScore ?? null, guidance },
      update: { adherenceScore, moodScore: dayStory?.moodScore ?? null, guidance },
    });
    // It worked — drop the backoff so a later story rewrite isn't held back by an old failure.
    await this.setSetting(`mentor.lastFail.${day}`, '').catch(() => undefined);
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
    // Also pull tasks added before the week but FINISHED in it — that is this week's follow-through.
    // Each is then credited to the day it was finished, not the day it was added. (BEA-1018)
    const tz = await this.tasks.timezone();
    const { start: weekStartAt } = await this.tasks.dayWindow(days[0], tz);
    const [tasks, mentorDays, dayStories] = await Promise.all([
      this.prisma.task.findMany({ where: { OR: [{ day: { gte: days[0], lte: days[6] } }, { completedAt: { gte: weekStartAt } }] } }),
      this.prisma.mentorDay.findMany({ where: { day: { gte: days[0], lte: days[6] } } }),
      this.prisma.dayStory.findMany({ where: { day: { gte: days[0], lte: days[6] } } }),
    ]);
    const done = tasks.filter((t) => t.status === 'done');
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
    const bucket = new Map(tasks.map((t) => [t.id, t.status === 'done' && t.completedAt ? this.tasks.dayKeyOf(t.completedAt, tz) : t.day || '']));
    const perDay = days.map((d) => ({ day: d, done: done.filter((t) => bucket.get(t.id) === d).length, total: tasks.filter((t) => bucket.get(t.id) === d).length }));
    const withTasks = perDay.filter((p) => p.total > 0);
    const best = withTasks.length ? withTasks.reduce((a, b) => (b.done / b.total > a.done / a.total ? b : a)) : null;
    const nums = (xs: any[]) => xs.filter((x): x is number => Number.isFinite(x as number));
    return {
      weekStart,
      tasksTotal: tasks.length,
      tasksDone: done.length,
      // Weighted like the Dashboard (done=100, else the task's own %), so the weekly review number
      // matches the home KPI instead of a binary done/total that disagreed on 30/60% weeks. (BEA-809)
      followThrough: tasks.length ? Math.round(tasks.reduce((s, t) => s + (t.status === 'done' ? 100 : (t.progress || 0)), 0) / tasks.length) : null,
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

    const labDigest = await this.mind.summaryForMentor().catch(() => ''); // what the Lab has learned about him — feed one fresh insight into the review (BEA-528)
    const tmpl = await this.prompts.get('mentor.weekly');
    const prompt =
      `${tmpl}\n\n` +
      `=== THE WEEK (${weekStart} .. ${days[6]}) ===\nToday is ${today}.\n${dayLines.join('\n')}\n${peopleBlock}\n` +
      `=== NUMBERS ===\nThis week: ${JSON.stringify(stats)}\nLast week: ${JSON.stringify(prevStats)}\n\n` +
      `=== HIS FOCUS AREAS ===\n${focus.map((f) => `- ${f.title}`).join('\n') || '(none set)'}\n\n` +
      (labDigest ? `=== WHAT THE LAB IS LEARNING ABOUT HIM (pick ONE fresh, specific insight to surface) ===\n${labDigest}\n\n` : '') +
      `=== LAST WEEK'S REVIEW ===\n${prevReview ? `${prevReview.text.slice(0, 700)}\nPattern then: ${prevReview.pattern || '-'}\nExperiment then: ${prevReview.experiment || '-'}` : '(this is the first weekly review)'}`;

    const raw = (await this.llm.completeWith(await this.weeklyModel(), prompt, 8000, 'weekly-review'))?.trim() || '';
    // Robust parse — never store a raw JSON blob as the review (BEA-884).
    const text = narrativeField(raw, 'review');
    const parsed = looseJsonParse(raw);
    const pattern: string | null = parsed?.pattern ? String(parsed.pattern).trim().slice(0, 300) : null;
    const experiment: string | null = parsed?.experiment ? String(parsed.experiment).trim().slice(0, 300) : null;
    if (!text) {
      // Silent before: three of his last four weekly reviews simply did not exist, 24 calls having
      // produced 5 reviews, and nothing anywhere said so. (BEA-1179)
      this.log.warn(`weeklyReview(${weekStart}): unusable reply (${raw.length} chars) — nothing written`);
      return null;
    }

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
    // Against the story's updatedAt, NOT its createdAt. The story row is upserted, so re-weaving it
    // leaves createdAt on the original write — and the read looked fresh forever while reflecting a
    // story you had since rewritten. (BEA-844)
    const storyAt = story ? new Date((story as any).updatedAt ?? story.createdAt) : null;
    if (read && (!storyAt || new Date(read.updatedAt) >= storyAt)) return; // already fresh
    if (await this.failedRecently(day)) return; // don't hammer a failing day once a minute (BEA-1178)
    await this.runMentorDay(day, true).catch(() => undefined);
  }

  /**
   * Did this day's read just fail? (BEA-1178)
   *
   * The nightly tick runs every 60 seconds and only asks "is there a fresh read?". When the reply
   * was unusable nothing got written, so the answer stayed no and it tried again the next minute,
   * and the next. On 27 July that was five paid calls between 00:07 and 00:11 — each one cut off —
   * until one happened to fit. Wait a while before trying that day again.
   */
  private async failedRecently(day: string): Promise<boolean> {
    try {
      const row = await this.prisma.setting?.findUnique({ where: { key: `mentor.lastFail.${day}` } });
      const at = Number(row?.value || 0);
      return at > 0 && Date.now() - at < MENTOR_RETRY_AFTER_MS;
    } catch {
      return false; // a lookup problem must never stop guidance being written at all
    }
  }

  /** Has this day already used up its two paid guidance runs? */
  private async paidToday(day: string): Promise<boolean> {
    // Defensive: if the lookup can't run, treat the day as UNPAID so guidance still gets written.
    // Failing closed here would silently stop the Lab working. (BEA-1140)
    try {
      const row = await this.prisma.setting?.findUnique({ where: { key: 'mentor.paidDay' } });
      const [d, n] = String(row?.value || '').split(':');
      return d === day && Number(n || 0) >= 2;
    } catch {
      return false;
    }
  }

  private async stampPaid(day: string): Promise<void> {
    // Must never throw — this sits directly in front of the paid call, so a failure here would
    // stop guidance being written at all. (BEA-1140)
    try {
      const cur = await this.prisma.setting?.findUnique({ where: { key: 'mentor.paidDay' } });
      const [pd, pn] = String(cur?.value || '').split(':');
      const next = `${day}:${pd === day ? Number(pn || 0) + 1 : 1}`;
      await this.prisma.setting?.upsert({ where: { key: 'mentor.paidDay' }, create: { key: 'mentor.paidDay', value: next }, update: { value: next } });
    } catch {
      /* the ceiling is a cost guard, not a correctness one */
    }
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
      await this.sendWeeklyLine(this.weekStartOf(day)).catch(() => undefined);
    } else {
      const lastWeek = this.dayAdd(this.weekStartOf(day), -7);
      if (!(await this.prisma.weeklyReview.findUnique({ where: { weekStart: lastWeek } }))) {
        await this.setSetting('mentor.weeklyTry', day);
        await this.generateWeeklyReview(lastWeek).catch(() => undefined);
      }
    }
  }

  /**
   * The Lab's one line a week on WhatsApp. (BEA-1144)
   *
   * Picks from what the weekly review already wrote plus the findings the Lab believes — no extra
   * AI call. Sends nothing at all when nothing crossed the bar; a message every Sunday regardless
   * of content is how you teach someone to ignore you.
   */
  async sendWeeklyLine(weekStart: string, force = false): Promise<{ sent: boolean; why?: string; line?: string }> {
    const already = (await this.prisma.setting.findUnique({ where: { key: 'mentor.weeklyPinged' } }).catch(() => null))?.value;
    if (!force && already === weekStart) return { sent: false, why: 'already sent this week' };

    const [review, findings, lastSent] = await Promise.all([
      this.prisma.weeklyReview.findUnique({ where: { weekStart } }).catch(() => null),
      this.prisma.mindFinding.findMany({
        where: surfacedWhere,
        orderBy: [{ daysSeen: 'desc' }],
        take: 10,
        select: { action: true, statement: true, daysSeen: true, validated: true },
      }).catch(() => [] as any[]),
      this.prisma.setting.findUnique({ where: { key: 'mentor.weeklyPingedText' } }).catch(() => null),
    ]);

    const pick = pickWeeklyLine({ findings: findings as any, review, lastSent: (lastSent as any)?.value ?? null });
    // Stamp the week either way, so a quiet week doesn't get re-checked every minute until Monday.
    await this.setSetting('mentor.weeklyPinged', weekStart).catch(() => undefined);
    if (!pick) return { sent: false, why: 'nothing worth saying this week' };

    const res = await this.alerts.labWeekly(weeklyMessage(pick), 'what the Lab noticed this week');
    if (res.sent) await this.setSetting('mentor.weeklyPingedText', pick.line).catch(() => undefined);
    return { ...res, line: pick.line };
  }
}
