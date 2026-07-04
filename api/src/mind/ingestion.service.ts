import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DaySignals, TaskSignal } from './mind.types';

// Local day-key helpers (the app stores days as YYYY-MM-DD local keys).
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function nextDay(day: string): string {
  const d = new Date(day + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return ymd(d);
}

/**
 * Gathers a day's raw signals into the structured bundle the mini mental model reasons over. (BEA-446)
 * The point is to capture INACTION (postponed / skipped) as richly as action (done) — that's where the
 * truth about a person lives. Pure read; no LLM here.
 */
@Injectable()
export class MindIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  // skippedOverride: the day's open tasks captured BEFORE close rolled them forward. Without it,
  // closeDay's rollover empties the day's open tasks before the Lab reads them, so "skipped" — the
  // signal the model calls the richest — was always empty. (BEA-808)
  async gatherDaySignals(day: string, today: string = ymd(new Date()), skippedOverride?: any[]): Promise<DaySignals> {
    const sig = (t: any): TaskSignal => ({
      id: t.id,
      title: t.title,
      category: t.category ?? null,
      sphere: t.sphere ?? 'work',
      priority: t.priority ?? 'medium',
      pinned: !!t.pinned,
      rolloverCount: t.rolloverCount ?? 0,
      status: t.status ?? 'open',
    });

    const planned = await this.prisma.task.findMany({ where: { day } });
    const done = planned.filter((t) => t.status === 'done').map(sig);
    const openPlanned = planned.filter((t) => t.status !== 'done');
    // Skipped = planned for a day already in the past but never done. Use the pre-rollover snapshot
    // when the caller (close) provides it, since the rollover has already moved them off the day. (BEA-808)
    const skipped = (skippedOverride ?? (day < today ? openPlanned : [])).map(sig);

    // Postponed = chronically deferred & still open (standing avoidance signals), most-deferred first.
    const postponed = (
      await this.prisma.task.findMany({ where: { status: 'open', rolloverCount: { gt: 0 } }, orderBy: { rolloverCount: 'desc' }, take: 12 })
    ).map(sig);

    // Captured that day.
    const start = new Date(day + 'T00:00:00');
    const end = new Date(nextDay(day) + 'T00:00:00');
    const created = (await this.prisma.task.findMany({ where: { createdAt: { gte: start, lt: end } } })).map(sig);

    const ideaRows = await this.prisma.idea.findMany({ where: { createdAt: { gte: start, lt: end } } });
    const ideas = ideaRows.map((i) => ({ id: i.id, title: i.title, content: (i.content || '').slice(0, 600) }));

    const storyRow = await this.prisma.story.findFirst({ where: { day }, orderBy: { createdAt: 'desc' } });
    let story: DaySignals['story'] = null;
    if (storyRow) {
      let wb: any = null;
      try {
        const p = JSON.parse(storyRow.workedBreakdown || 'null');
        if (Array.isArray(p)) wb = p;
      } catch {
        /* ignore */
      }
      story = { rawText: storyRow.rawText, mood: storyRow.mood ?? null, workedMinutes: storyRow.workedMinutes ?? null, workedBreakdown: wb };
    }

    const summaryRow = await this.prisma.daySummary.findUnique({ where: { day } }).catch(() => null);
    const daySummary = summaryRow?.text ?? null;

    // Wider signals (BEA-453): that day's important emails + meetings.
    const emailRows = await this.prisma.emailMemory.findMany({ where: { day }, take: 15 }).catch(() => [] as any[]);
    const emails = emailRows.map((e) => ({ from: e.fromAddr || '', subject: e.subject || '', snippet: (e.snippet || '').slice(0, 200) }));
    const meetingRows = await this.prisma.meeting.findMany({ where: { createdAt: { gte: start, lt: end } }, take: 8 }).catch(() => [] as any[]);
    const meetings = meetingRows.map((m) => {
      let decisions: string[] = [];
      try {
        const d = JSON.parse(m.decisions || '[]');
        if (Array.isArray(d)) decisions = d.map((x) => String(x)).slice(0, 5);
      } catch {
        /* ignore */
      }
      return { title: m.title || 'Meeting', summary: (m.summary || '').slice(0, 600), decisions };
    });

    const counts = { done: done.length, open: openPlanned.length, skipped: skipped.length, postponed: postponed.length, created: created.length };
    const hasSignal = done.length > 0 || skipped.length > 0 || postponed.length > 0 || !!story || !!daySummary || ideas.length > 0 || created.length > 0 || emails.length > 0 || meetings.length > 0;

    return { day, tasks: { done, skipped, postponed, created, counts }, story, daySummary, ideas, emails, meetings, hasSignal };
  }
}
