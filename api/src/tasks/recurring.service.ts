import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey, localHour, weekdayOf } from '../common/localday';
import { isOwedOn, parseSchedule, serialiseSchedule, daysFromTitle, scheduleLabel } from './schedule';

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

  /** The hour (owner's time) after which a day is closed and the miss summary goes out. */
  async digestHour(): Promise<number> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'recurring.digestHour' } }).catch(() => null);
    const n = Number(row?.value);
    return Number.isFinite(n) && n >= 0 && n <= 23 ? Math.floor(n) : 20; // 20:00 local by default
  }

  /**
   * Close today once its last slot has passed: anything still outstanding becomes a recorded miss,
   * and the list of misses is returned for ONE summary to the owner. Runs at most once per day
   * (tracked in a setting), and never on a rest day — nothing was owed, so nothing was missed.
   * Returns null when there is nothing to say. (BEA-1121)
   */
  async closeDay(now: Date = new Date()): Promise<{ day: string; missed: { title: string; contact: string | null }[] } | null> {
    const day = this.today(now);
    if (localHour(now) < (await this.digestHour())) return null; // the day is not over yet
    const already = await this.prisma.setting.findUnique({ where: { key: 'recurring.closedDay' } }).catch(() => null);
    if (already?.value === day) return null; // already closed — one summary a day, never a repeat
    const markClosed = async () => {
      await this.prisma.setting
        .upsert({ where: { key: 'recurring.closedDay' }, create: { key: 'recurring.closedDay', value: day }, update: { value: day } })
        .catch(() => undefined);
    };
    // A task with its own schedule overrides the global rest day, so the rest-day shortcut can no
    // longer skip the whole close — a Sunday report is real if the owner set one. (BEA-1147)
    const rest = await this.restDays();
    const weekday = weekdayOf(day);

    const tasks = await this.prisma.task
      .findMany({
        where: { kind: 'recurring', status: { not: 'done' } },
        select: { id: true, title: true, scheduleDays: true, ownerContact: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      })
      .catch(() => [] as any[]);
    const owed = (tasks as any[]).filter((t) => isOwedOn(t.scheduleDays, weekday, rest));
    if (!owed.length) { await markClosed(); return null; } // nothing was due — nothing can be missed

    const missed: { title: string; contact: string | null }[] = [];
    for (const t of owed) {
      if (await this.isReceived(t.id, day)) continue;
      const fresh = await this.markMissed(t.id, day);
      if (fresh) missed.push({ title: t.title, contact: t.ownerContact?.name || null });
    }
    await markClosed();
    if (!missed.length) return null;
    this.log.log(`closed ${day}: ${missed.length} daily report(s) missed`);
    return { day, missed };
  }

  /** Set the days a standing report is owed on. Empty clears it back to every working day. */
  async setSchedule(taskId: string, days: unknown): Promise<{ taskId: string; schedule: string[] | null; label: string }> {
    const value = serialiseSchedule(days);
    await this.prisma.task.update({ where: { id: taskId }, data: { scheduleDays: value } }).catch((e) => this.log.warn(`setSchedule: ${e?.message}`));
    return { taskId, schedule: parseSchedule(value), label: scheduleLabel(value) };
  }

  /**
   * One-time seed: read each existing report's own title for the day it names. Only titles that
   * actually name a day are touched — nothing is guessed, because a wrong guess chases a colleague
   * on the wrong day, which is the bug this exists to end. (BEA-1147)
   */
  async seedSchedulesFromTitles(): Promise<{ set: { title: string; days: string[] }[]; untouched: string[] }> {
    const tasks = await this.prisma.task
      .findMany({ where: { kind: 'recurring', status: { not: 'done' }, scheduleDays: null }, select: { id: true, title: true } })
      .catch(() => [] as any[]);
    const set: { title: string; days: string[] }[] = [];
    const untouched: string[] = [];
    for (const t of tasks as any[]) {
      const days = daysFromTitle(t.title);
      if (!days) { untouched.push(t.title); continue; }
      await this.prisma.task.update({ where: { id: t.id }, data: { scheduleDays: JSON.stringify(days) } }).catch(() => undefined);
      set.push({ title: t.title, days });
    }
    if (set.length) this.log.log(`seeded ${set.length} report schedule(s) from their titles`);
    return { set, untouched };
  }

  /** The day's ledger for the Review tab: who owed what, and whether it came in. */
  async dayLog(day?: string) {
    const key = day || this.today();
    const [tasks, rows, rest] = await Promise.all([
      this.prisma.task.findMany({
        where: { kind: 'recurring', status: { not: 'done' } },
        select: { id: true, title: true, scheduleDays: true, ownerContact: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }).catch(() => [] as any[]),
      this.prisma.taskStatusDay.findMany({ where: { day: key } }).catch(() => [] as any[]),
      this.restDays(),
    ]);
    const byTask = new Map<string, any>((rows as any[]).map((r) => [r.taskId, r]));
    const weekday = weekdayOf(key);
    // Reports not due today are listed separately, never counted as waiting or missed. Counting a
    // Friday report as outstanding on a Monday is what made this number meaningless. (BEA-1147)
    const all = (tasks as any[]).map((t) => {
      const r = byTask.get(t.id);
      const due = isOwedOn(t.scheduleDays, weekday, rest as string[]);
      return {
        taskId: t.id,
        title: t.title,
        contact: t.ownerContact ? { id: t.ownerContact.id, name: t.ownerContact.name } : null,
        schedule: parseSchedule(t.scheduleDays),
        scheduleLabel: scheduleLabel(t.scheduleDays),
        due,
        status: !due ? 'off' : r?.status || 'waiting',
        quote: r?.quote || null,
        at: r?.createdAt || null,
      };
    });
    const items = all.filter((i) => i.due);
    return {
      day: key,
      weekday,
      restDay: (rest as string[]).includes(weekday),
      items,
      notDueToday: all.filter((i) => !i.due),
      counts: {
        due: items.length,
        received: items.filter((i) => i.status === 'received').length,
        missed: items.filter((i) => i.status === 'missed').length,
        waiting: items.filter((i) => i.status === 'waiting').length,
      },
    };
  }
}
