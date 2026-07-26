import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { DailyService } from '../daily/daily.service';
import { RecurringService } from '../tasks/recurring.service';
import { MemoryService } from '../memory/memory.service';

type NeedItem = { kind: string; icon: string; title: string; sub: string; href: string; action: string };
type CookItem = { icon: string; label: string; href: string };

const LANE_ICON: Record<string, string> = { search: '🔎', research: '🧪', reminder: '⏰', task: '✅', note: '📝', meeting: '🎧', story: '🎙' };

@Injectable()
export class HomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly daily: DailyService,
    private readonly recurring: RecurringService,
    private readonly memory: MemoryService,
  ) {}

  /**
   * A count that can never take the landing page down. Home is the first screen of the app; one
   * unavailable table must not turn the whole dashboard into an error. (BEA-1136)
   */
  private async safeCount(model: string, where: any): Promise<number> {
    try {
      const m = (this.prisma as any)[model];
      if (!m?.count) return 0;
      return (await m.count({ where })) || 0;
    } catch {
      return 0;
    }
  }

  /** How many things the brain knows — the same number Explore shows. (BEA-1136) */
  private async brainSize(): Promise<number> {
    const r = await this.memory.brainCounts();
    return r.total;
  }

  /** Everything the Home command-center needs, in one call. */
  async summary() {
    const [today, dailyToday, dash, activity, personality] = await Promise.all([
      this.tasks.today(),
      this.daily.today(),
      this.daily.dashboard(30),
      this.daily.activity(),
      this.daily.getPersonality(),
    ]);

    // IST day boundaries — for "queued today" and the today-delta counts.
    const dayKey: string = activity.day || new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    const todayStart = new Date(dayKey + 'T00:00:00+05:30');
    const todayEnd = new Date(todayStart.getTime() + 86400000);

    const [documents, bookmarks, ideas, skills, notes, contacts, meetings, emoCards] = await Promise.all([
      this.prisma.item.count({ where: { source: { not: 'raindrop' } } }),
      this.prisma.item.count({ where: { source: 'raindrop' } }),
      this.prisma.idea.count(),
      this.prisma.skill.count(),
      this.prisma.note.count(),
      this.prisma.contact.count(),
      this.prisma.meeting.count(),
      this.prisma.emoCard.count(),
    ]);
    // Today-new deltas (cheap, indexed on createdAt).
    const since = { createdAt: { gte: todayStart } };
    const [nDocs, nIdeas, nSkills, nNotes, nMeet, nEmo, nBook, nCont] = await Promise.all([
      this.prisma.item.count({ where: { source: { not: 'raindrop' }, ...since } }),
      this.prisma.idea.count({ where: since }),
      this.prisma.skill.count({ where: since }),
      this.prisma.note.count({ where: since }),
      this.prisma.meeting.count({ where: since }),
      this.prisma.emoCard.count({ where: since }),
      this.prisma.item.count({ where: { source: 'raindrop', ...since } }),
      this.prisma.contact.count({ where: since }),
    ]);

    const recentRows = await this.prisma.item.findMany({
      where: { source: { not: 'raindrop' } },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, title: true, source: true, createdAt: true },
    });

    const mustDos = (today.tasks || []).filter((t: any) => t.status === 'open').slice(0, 3);

    // ---- NEEDS YOU — everything waiting on the user, across the app ----
    const [emoNeeds, agentWaiting, flowWaiting, remindersNeed, overdue, guidanceRow, claimsWaiting] = await Promise.all([
      this.prisma.emoCard.findMany({ where: { status: 'needs_you' }, orderBy: { createdAt: 'desc' }, take: 6 }),
      this.prisma.agentRun.findMany({ where: { status: 'awaiting_input' }, orderBy: { startedAt: 'desc' }, take: 4 }),
      this.prisma.flowRun.findMany({ where: { status: 'running', waitQuestion: { not: null } }, orderBy: { startedAt: 'desc' }, take: 4 }),
      this.prisma.reminder.findMany({ where: { needsOwner: true, status: 'active' }, include: { contact: true }, take: 5 }),
      this.prisma.task.findMany({ where: { status: 'open', dueDate: { lt: todayStart } }, orderBy: { dueDate: 'asc' }, take: 3 }),
      this.prisma.mentorDay.findFirst({ orderBy: { day: 'desc' } }),
      // Work someone says they've finished, waiting on your yes or no. (BEA-1025)
      this.prisma.taskClaim.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 5,
        include: { contact: { select: { name: true } }, task: { select: { title: true } } },
      }),
    ]);

    const needsYou: NeedItem[] = [];
    for (const c of emoNeeds) needsYou.push({ kind: 'emo', icon: LANE_ICON[c.lane] || '🎙', title: (c.summary || 'Emo card').slice(0, 90), sub: (c.needsQuestion || 'Needs your answer').slice(0, 120), href: '/emo', action: 'Answer' });
    for (const r of agentWaiting) needsYou.push({ kind: 'agent', icon: '🤖', title: (r.title || 'Agent run').slice(0, 90), sub: 'Waiting on your input', href: `/agent/runs/${r.id}`, action: 'Reply' });
    for (const f of flowWaiting) needsYou.push({ kind: 'flow', icon: '🌊', title: 'A flow needs your input', sub: (f.waitQuestion || '').slice(0, 120), href: `/flows/runs/${f.id}`, action: 'Reply' });
    for (const r of remindersNeed as any[]) needsYou.push({ kind: 'reminder', icon: '⏰', title: `${r.contact?.name || 'A contact'} needs a reply`, sub: (r.subject ? `about ${r.subject}` : 'Their WhatsApp reply is waiting'), href: '/contacts', action: 'Read' });
    for (const t of overdue as any[]) needsYou.push({ kind: 'task', icon: '⚠️', title: (t.title || 'Task').slice(0, 90), sub: 'Overdue', href: '/tasks', action: 'Do' });
    for (const c of claimsWaiting as any[]) needsYou.push({ kind: 'claim', icon: '✋', title: `${c.contact?.name || 'Someone'} says it's done`, sub: (c.task?.title || '').slice(0, 120), href: '/tasks?tab=review', action: 'Review' });

    // Rank by urgency (most time-sensitive first) and drop duplicates. (BEA-939)
    const NEED_RANK: Record<string, number> = { claim: 0, reminder: 1, task: 2, agent: 3, flow: 4, meeting: 5, emo: 6 };
    const seenNeed = new Set<string>();
    const rankedNeedsYou = needsYou
      .filter((x) => { const k = `${x.kind}|${x.href}|${x.title}`; if (seenNeed.has(k)) return false; seenNeed.add(k); return true; })
      .sort((a, b) => (NEED_RANK[a.kind] ?? 9) - (NEED_RANK[b.kind] ?? 9));

    // ---- COOKING — what's running in the background ----
    const [agentRunning, flowRunning, emoCooking, remQueuedToday, meetTranscribing] = await Promise.all([
      this.prisma.agentRun.count({ where: { status: 'running' } }),
      this.prisma.flowRun.count({ where: { status: 'running' } }),
      this.prisma.emoCard.count({ where: { status: 'cooking' } }),
      this.prisma.reminderSend.count({ where: { status: 'queued', at: { gte: todayStart, lt: todayEnd } } }),
      this.prisma.meeting.count({ where: { status: 'transcribing' } }),
    ]);
    const cooking: CookItem[] = [];
    const s = (n: number) => (n === 1 ? '' : 's');
    if (agentRunning) cooking.push({ icon: '🤖', label: `${agentRunning} agent run${s(agentRunning)} running`, href: '/agent' });
    if (flowRunning) cooking.push({ icon: '🌊', label: `${flowRunning} flow${s(flowRunning)} running`, href: '/flows' });
    if (emoCooking) cooking.push({ icon: '🎙', label: `${emoCooking} Emo card${s(emoCooking)} cooking`, href: '/emo' });
    if (remQueuedToday) cooking.push({ icon: '⏰', label: `${remQueuedToday} reminder${s(remQueuedToday)} queued today`, href: '/contacts' });
    if (meetTranscribing) cooking.push({ icon: '🎧', label: `${meetTranscribing} meeting${s(meetTranscribing)} transcribing`, href: '/meetings' });

    // ---- The facts the dashboard runs on (BEA-1136) ----
    // Home only ever fetched INVENTORY — documents, bookmarks, skills. None of it is something the
    // owner acts on. These are the numbers he actually runs his day from; every one already exists
    // somewhere in the app, Home simply never asked. All indexed counts, gathered in parallel.
    const restDays = await this.recurring?.restDays().catch(() => ['Sun']) ?? ['Sun'];
    const isRestDay = restDays.includes(new Date(dayKey + 'T00:00:00Z').toUTCString().slice(0, 3));
    const [
      toReview, delegatedOpen, dailyOwed, dailyIn, dailyMissed, overdueCount, carriedOver, doneToday, openTasks, brainSize,
    ] = await Promise.all([
      this.safeCount('taskClaim', { status: 'pending' }),
      this.safeCount('task', { status: { not: 'done' }, kind: { not: 'recurring' }, NOT: { ownerContactId: null } }),
      this.safeCount('task', { kind: 'recurring', status: { not: 'done' } }),
      this.safeCount('taskStatusDay', { day: dayKey, status: 'received' }),
      this.safeCount('taskStatusDay', { day: dayKey, status: 'missed' }),
      this.safeCount('task', { status: { not: 'done' }, dueDate: { lt: todayStart } }),
      this.safeCount('task', { status: { not: 'done' }, rolloverCount: { gt: 0 } }),
      this.safeCount('task', { status: 'done', completedAt: { gte: todayStart, lt: todayEnd } }),
      this.safeCount('task', { status: { not: 'done' }, kind: { not: 'recurring' } }),
      this.brainSize().catch(() => 0),
    ]);
    const stalling = await (this.tasks.stalling?.() ?? Promise.resolve([])).then((r: any[]) => r.length).catch(() => 0);

    // Day summary: today's once it exists, otherwise yesterday's (mornings shouldn't show empty).
    let summaryText: string | null = activity.summary?.text || null;
    let summaryFor: 'today' | 'yesterday' | null = summaryText ? 'today' : null;
    if (!summaryText && activity.day) {
      const y = new Date(activity.day + 'T12:00:00Z');
      y.setUTCDate(y.getUTCDate() - 1);
      const row = await this.prisma.daySummary.findUnique({ where: { day: y.toISOString().slice(0, 10) } });
      if (row?.text) { summaryText = row.text; summaryFor = 'yesterday'; }
    }

    return {
      today: { dumped: today.dumped, storyDone: dailyToday.storyDone, counts: today.counts, mustDos },
      insights: {
        streak: dash.streak,
        followThrough: dash.totals.followThrough,
        followTrend: dash.followTrend,
        minutesSpent: dash.minutesSpent,
        // Prefer the user's stated close-day minutes (the truth — they do plenty they never log as
        // tasks); fall back to auto-counted only when they haven't closed the day yet. (BEA-937)
        minutesToday: activity.stats?.workedMinutes ?? activity.stats?.minutesSpent ?? 0,
        daySummary: summaryText ? summaryText.replace(/\s+/g, ' ').trim().slice(0, 600) : null,
        daySummaryFor: summaryFor,
        guidance: guidanceRow?.guidance || null,
        guidanceDay: guidanceRow?.day || null,
      },
      personality: { unlocked: personality.unlocked, summary: personality.summary, daysCovered: personality.daysCovered, minDays: personality.minDays },
      counts: { documents, bookmarks, ideas, skills, notes, contacts, meetings, emoCards, brain: brainSize },
      // Grouped exactly as the dashboard bands render them, so the page does no arithmetic. (BEA-1136)
      facts: {
        needsYou: { needsYou: rankedNeedsYou.length, toReview, missedToday: dailyMissed, overdue: overdueCount },
        yourDay: { open: openTasks, doneToday, carriedOver, dumped: today.dumped, storyDone: dailyToday.storyDone },
        owed: { delegatedOpen, stalling, dailyIn, dailyOwed, restDay: isRestDay, remindersQueued: remQueuedToday },
      },
      countsNew: { documents: nDocs, bookmarks: nBook, ideas: nIdeas, skills: nSkills, notes: nNotes, contacts: nCont, meetings: nMeet, emoCards: nEmo },
      needsYou: rankedNeedsYou,
      cooking,
      recent: recentRows.map((r) => ({ id: r.id, title: r.title || 'Untitled', source: r.source, createdAt: r.createdAt })),
    };
  }
}
