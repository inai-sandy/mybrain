import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey, weekdayOf } from '../common/localday';

/** Weekday names a rest day can be set to. */
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Nobody owes a daily report on a Sunday unless the owner says otherwise. (BEA-1117) */
export const DEFAULT_REST_DAYS = ['Sun'];

/**
 * Recurring work — a standing daily report that never finishes (BEA-1117).
 *
 * An assignment is chased until the owner confirms it done. A recurring report can't be confirmed
 * done at all: confirming it would stop the chase forever, and tomorrow's update would never be
 * asked for. So the unit of truth is the DAY: a real status arriving satisfies today, and the same
 * report is owed again tomorrow. This service owns that per-day ledger and the rest-day rule.
 */
@Injectable()
export class RecurringService {
  private readonly log = new Logger('Recurring');

  constructor(private readonly prisma: PrismaService) {}

  /** Today, in the owner's timezone. */
  today(now: Date = new Date()): string {
    return localDayKey(now);
  }

  /** Days on which no daily report is owed — no chasing, and no "missed" recorded. */
  async restDays(): Promise<string[]> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'recurring.restDays' } }).catch(() => null);
    if (!row?.value) return DEFAULT_REST_DAYS;
    try {
      const a = JSON.parse(row.value);
      if (!Array.isArray(a)) return DEFAULT_REST_DAYS;
      const clean = a.filter((d: unknown) => typeof d === 'string' && WEEKDAYS.includes(d));
      return clean; // an explicit [] is valid: chase every day
    } catch {
      return DEFAULT_REST_DAYS;
    }
  }

  async setRestDays(days: unknown): Promise<{ days: string[] }> {
    const clean = Array.isArray(days) ? [...new Set(days.filter((d) => typeof d === 'string' && WEEKDAYS.includes(d as string)))] as string[] : DEFAULT_REST_DAYS;
    await this.prisma.setting.upsert({
      where: { key: 'recurring.restDays' },
      create: { key: 'recurring.restDays', value: JSON.stringify(clean) },
      update: { value: JSON.stringify(clean) },
    });
    return { days: clean };
  }

  /** Is nothing owed on this day? */
  async isRestDay(dayKey: string): Promise<boolean> {
    return (await this.restDays()).includes(weekdayOf(dayKey));
  }

  /** Every recurring task belonging to a contact that is still live. */
  async recurringTasksFor(contactId: string) {
    return this.prisma.task
      .findMany({ where: { ownerContactId: contactId, kind: 'recurring', status: { not: 'done' } }, select: { id: true, title: true } })
      .catch(() => [] as { id: string; title: string }[]);
  }

  /**
   * Today's report arrived. Idempotent per task per day, and a later arrival always upgrades a
   * "missed" to "received" — the ledger records what actually happened, not what we guessed first.
   */
  async markReceived(taskId: string, day: string, quote?: string | null, contactId?: string | null) {
    const words = (quote || '').trim().slice(0, 1000) || null;
    await this.prisma.taskStatusDay
      .upsert({
        where: { taskId_day: { taskId, day } },
        create: { taskId, day, status: 'received', quote: words, contactId: contactId || null },
        update: { status: 'received', quote: words ?? undefined, contactId: contactId || undefined },
      })
      .catch((e) => this.log.warn(`markReceived: ${e?.message}`));
  }

  /** Has today's report already arrived? Drives "stop chasing for the rest of today". */
  async isReceived(taskId: string, day: string): Promise<boolean> {
    const row = await this.prisma.taskStatusDay.findUnique({ where: { taskId_day: { taskId, day } }, select: { status: true } }).catch(() => null);
    return row?.status === 'received';
  }

  /** Close the day as missed — never overwrites a status that did arrive. */
  async markMissed(taskId: string, day: string, contactId?: string | null): Promise<boolean> {
    const existing = await this.prisma.taskStatusDay.findUnique({ where: { taskId_day: { taskId, day } }, select: { status: true } }).catch(() => null);
    if (existing) return false; // received, or already closed as missed
    await this.prisma.taskStatusDay
      .create({ data: { taskId, day, status: 'missed', contactId: contactId || null } })
      .catch(() => undefined);
    return true;
  }

  /** The day's ledger for the Review tab: who owed what, and whether it came in. */
  async dayLog(day?: string) {
    const key = day || this.today();
    const [tasks, rows, rest] = await Promise.all([
      this.prisma.task.findMany({
        where: { kind: 'recurring', status: { not: 'done' } },
        select: { id: true, title: true, ownerContact: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }).catch(() => [] as any[]),
      this.prisma.taskStatusDay.findMany({ where: { day: key } }).catch(() => [] as any[]),
      this.isRestDay(key),
    ]);
    const byTask = new Map<string, any>((rows as any[]).map((r) => [r.taskId, r]));
    return {
      day: key,
      weekday: weekdayOf(key),
      restDay: rest,
      items: (tasks as any[]).map((t) => {
        const r = byTask.get(t.id);
        return {
          taskId: t.id,
          title: t.title,
          contact: t.ownerContact ? { id: t.ownerContact.id, name: t.ownerContact.name } : null,
          // On a rest day nothing is owed, so an absent row is 'off', never a miss.
          status: r?.status || (rest ? 'off' : 'waiting'),
          quote: r?.quote || null,
          at: r?.createdAt || null,
        };
      }),
    };
  }
}
