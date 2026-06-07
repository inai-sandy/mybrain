import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { TasksService } from '../tasks/tasks.service';

const DEFAULT_TZ = 'Asia/Kolkata';
const SUMMARY_AT = '21:30'; // local time the auto day-summary fires

type TimelineEvent = { type: string; title: string; detail?: string; at: string };

@Injectable()
export class DailyService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly memory: MemoryService,
    private readonly tasks: TasksService,
  ) {}

  onModuleInit() {
    this.tick = setInterval(() => this.summaryTick().catch(() => undefined), 60_000);
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

  async submitStory(rawText: string, source = 'app', mood?: string) {
    const text = (rawText || '').trim();
    if (!text) return null;
    const day = this.dayKey(await this.tz());
    const existing = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    const row = existing
      ? await this.prisma.story.update({ where: { id: existing.id }, data: { rawText: text, source, mood: mood ?? existing.mood } })
      : await this.prisma.story.create({ data: { day, rawText: text, source, mood: mood || null } });
    return this.shapeStory(row);
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

    const prompt =
      `Write a warm but honest end-of-day summary addressed to Sandeep ("you"). 2-4 short paragraphs.\n` +
      `Cover: what he got done, what's still pending, and reflect briefly on his own story of the day if present. Be specific and concrete; do not invent anything not listed. No headings, no markdown bullets — flowing prose.\n\n` +
      `Tasks done (${st.tasksDone}/${st.tasksTotal}, ~${st.minutesSpent}m):\n${doneList.join('\n') || '(none)'}\n\n` +
      `Still pending:\n${openList.join('\n') || '(none)'}\n\n` +
      `Other activity in the app:\n${activityLines.join('\n') || '(none)'}\n\n` +
      `His story of the day${story?.mood ? ` (mood: ${story.mood})` : ''}:\n${story?.rawText?.slice(0, 2000) || '(not told)'}`;

    const text = (await this.llm.completeWith(await this.tasks.getModel(), prompt, 900))?.trim() || this.fallbackSummary(st, doneList, openList);
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

    return {
      days: span,
      totals: { tasksTotal: tasks.length, tasksDone: done.length, followThrough: tasks.length ? Math.round((done.length / tasks.length) * 100) : 0 },
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
    const byDay: Record<string, { done: number; total: number }> = {};
    for (const t of tasks) {
      const k = t.day || '';
      if (!k) continue;
      byDay[k] = byDay[k] || { done: 0, total: 0 };
      byDay[k].total++;
      if (t.status === 'done') byDay[k].done++;
    }
    const all = new Set([...Object.keys(byDay), ...dumps, ...stories]);
    return {
      start,
      end: today,
      days: [...all].sort().map((day) => ({
        day,
        done: byDay[day]?.done || 0,
        total: byDay[day]?.total || 0,
        dumped: dumps.has(day),
        story: stories.has(day),
      })),
    };
  }

  /** Everything for the Activity screen for a given day (defaults to today). */
  async activity(dayInput?: string) {
    const tz = await this.tz();
    const day = dayInput && /^\d{4}-\d{2}-\d{2}$/.test(dayInput) ? dayInput : this.dayKey(tz);
    const [timeline, st, story, summary] = await Promise.all([
      this.feed(day, tz),
      this.stats(day),
      this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } }),
      this.prisma.daySummary.findUnique({ where: { day } }),
    ]);
    return {
      day,
      isToday: day === this.dayKey(tz),
      stats: st,
      story: story ? this.shapeStory(story) : null,
      summary: summary ? this.shapeSummary(summary) : null,
      timeline,
    };
  }
}
