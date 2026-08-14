import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { localDayKey, localHour, weekdayOf } from '../common/localday';
import { isOwedOn, parseSchedule, serialiseSchedule, daysFromTitle, scheduleLabel } from './schedule';
import { laterWins } from '../contacts/promise-later';
import { TASK_SETTING_KEYS, TASK_DEFAULTS, parseChaseTimes, parseClaimGraceDays } from './task-settings';
import { TASK_OPEN } from './task-status';

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
export class RecurringService implements OnModuleInit {
  private readonly log = new Logger('Recurring');

  constructor(
    private readonly prisma: PrismaService,
    // Optional and LAST: spec harnesses build this service positionally with fewer args.
    @Optional() private readonly llm?: LlmService,
    @Optional() private readonly prompts?: PromptsService,
  ) {}

  onModuleInit() {
    // One-time catch-up: summarize the last week's reports that arrived before summaries existed,
    // so the section reads well from day one. Bounded and delayed off the boot path. (BEA-1223)
    setTimeout(() => this.summarizeBacklog().catch(() => undefined), 30_000);
  }

  /**
   * The 1–2 line summary of one day's report (BEA-1223) — written ONCE when the report arrives,
   * so the owner reads what was said, not plumbing. Fire-and-forget: a model failure just leaves
   * the quote, which the UI already falls back to. A short quote IS its own summary.
   */
  private async summarizeRow(rowId: string, taskId: string, quote: string): Promise<void> {
    if (!this.llm || !this.prompts) return;
    const q = (quote || '').trim();
    if (q.length < 60) return; // already one line — burning a model call would add nothing
    try {
      // The title lookup lives HERE so the webhook hot path never waits on it. (review finding)
      const title = ((await Promise.resolve(this.prisma.task?.findUnique?.({ where: { id: taskId }, select: { title: true } })).catch(() => null)) as any)?.title || 'Daily report';
      const tmpl = await this.prompts.get('people.reportSummary');
      const raw = await this.llm.completeHelper('report-summary', tmpl.replace(/\{\{title\}\}/g, title.slice(0, 120)).replace(/\{\{report\}\}/g, q.slice(0, 1500)), 120, 'report-summary');
      const summary = (raw || '').trim().replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 300);
      if (summary.length < 8) return; // junk writes nothing — the quote fallback stands
      await this.prisma.taskStatusDay.update({ where: { id: rowId }, data: { summary } }).catch(() => undefined);
    } catch {
      /* the quote fallback stands */
    }
  }

  /** Summarize recent received rows that predate summaries. Runs once per boot, capped. */
  async summarizeBacklog(): Promise<number> {
    if (!this.llm || !this.prompts) return 0;
    const since = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const rows = await this.prisma.taskStatusDay
      .findMany({
        where: { status: 'received', summary: null, day: { gte: since }, quote: { not: null } },
        select: { id: true, quote: true, taskId: true },
        take: 30,
      })
      .catch(() => [] as any[]);
    let n = 0;
    for (const r of rows as any[]) {
      if ((r.quote || '').trim().length < 60) continue;
      await this.summarizeRow(r.id, r.taskId, r.quote);
      n++;
    }
    if (n) this.log.log(`summarized ${n} recent report(s)`);
    return n;
  }

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
      .findMany({ where: { ownerContactId: contactId, kind: 'recurring', status: TASK_OPEN }, select: { id: true, title: true } })
      .catch(() => [] as { id: string; title: string }[]);
  }

  /**
   * Today's report arrived. Idempotent per task per day, and a later arrival always upgrades a
   * "missed" to "received" — the ledger records what actually happened, not what we guessed first.
   */
  async markReceived(taskId: string, day: string, quote?: string | null, contactId?: string | null, opts?: { source?: string; at?: Date }) {
    const words = (quote || '').trim().slice(0, 1000) || null;
    const at = opts?.at ?? new Date();
    const source = opts?.source ?? null;
    // The LATER signal wins. A share-page tick followed by "sending at 12" must not stay received,
    // and a stale retry must never flip a settled day back. (BEA-1152)
    const existing = await this.prisma.taskStatusDay.findUnique({ where: { taskId_day: { taskId, day } }, select: { signalAt: true, quote: true } }).catch(() => null);
    if (existing && !laterWins(existing.signalAt, at)) return;
    // A resend of the SAME words must not wipe a good summary and pay for a new one. (review finding)
    const newWords = !!words && words !== existing?.quote;
    const row = await this.prisma.taskStatusDay
      .upsert({
        where: { taskId_day: { taskId, day } },
        create: { taskId, day, status: 'received', quote: words, contactId: contactId || null, source, signalAt: at },
        // NEW words replace the old summary with them — a resend of the same words keeps both. (BEA-1223)
        update: { status: 'received', quote: words ?? undefined, contactId: contactId || undefined, source: source ?? undefined, signalAt: at, ...(newWords ? { summary: null } : {}) },
      })
      .catch((e) => { this.log.warn(`markReceived: ${e?.message}`); return null; });
    // Fully fire-and-forget: the day is settled either way; the summary lands seconds later. (BEA-1223)
    if (row && newWords) void this.summarizeRow((row as any).id, taskId, words!);
  }

  /**
   * Today's report did NOT arrive after all — they said so themselves, after an earlier tick.
   * The day goes back to waiting and the chase resumes. (BEA-1152)
   */
  async markNotReceived(taskId: string, day: string, quote?: string | null, contactId?: string | null, opts?: { source?: string; at?: Date }): Promise<boolean> {
    const at = opts?.at ?? new Date();
    const existing = await this.prisma.taskStatusDay.findUnique({ where: { taskId_day: { taskId, day } }, select: { status: true, signalAt: true } }).catch(() => null);
    if (!existing) return false; // nothing recorded — already waiting
    if (!laterWins(existing.signalAt, at)) return false; // an older signal cannot undo a newer one
    if (existing.status !== 'received') return false;
    await this.prisma.taskStatusDay
      .delete({ where: { taskId_day: { taskId, day } } })
      .catch((e) => this.log.warn(`markNotReceived: ${e?.message}`));
    this.log.log(`un-marked ${taskId} for ${day} — they said it is still coming`);
    return true;
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
        where: { kind: 'recurring', status: TASK_OPEN },
        select: { id: true, title: true, scheduleDays: true, ownerContact: { select: { name: true } } },
        orderBy: { createdAt: 'asc' },
      })
      .catch(() => [] as any[]);
    const owed = (tasks as any[]).filter((t) => isOwedOn(t.scheduleDays, weekday, rest));
    if (!owed.length) { await markClosed(); return null; } // nothing was due — nothing can be missed

    // Work that changed hands TODAY is not missed by anybody. (BEA-1308)
    //
    // The miss summary reads the owner at close time, so a report handed over this morning would
    // name the NEW person for a day that was mostly not theirs — and, before the handover started a
    // chase for them, for a day they were never once asked about. Nobody is blamed for a disrupted
    // day; tomorrow is theirs properly.
    const dayStart = new Date(`${day}T00:00:00.000Z`);
    const movedToday = new Set<string>(
      (
        ((await Promise.resolve(
          this.prisma.taskHandover?.findMany?.({ where: { taskId: { in: owed.map((t: any) => t.id) }, at: { gte: dayStart } }, select: { taskId: true } }),
        ).catch(() => [])) ?? []) as any[]
      ).map((h: any) => h.taskId),
    );

    const missed: { title: string; contact: string | null }[] = [];
    for (const t of owed) {
      if (await this.isReceived(t.id, day)) continue;
      if (movedToday.has(t.id)) continue;
      const fresh = await this.markMissed(t.id, day);
      if (fresh) missed.push({ title: t.title, contact: t.ownerContact?.name || null });
    }
    await markClosed();
    if (!missed.length) return null;
    this.log.log(`closed ${day}: ${missed.length} daily report(s) missed`);
    return { day, missed };
  }

  /**
   * Every rule that decides how the team gets chased, in one place for the Tasks settings screen.
   * Each value carries a plain-English reading of what it currently means — a bare weekday picker
   * tells the owner nothing about what it does. (BEA-1161)
   */
  async taskSettings() {
    const get = async (k: string) => (await this.prisma.setting.findUnique({ where: { key: k } }).catch(() => null))?.value ?? null;
    const [restRaw, hourRaw, timesRaw, graceRaw, tzRaw] = await Promise.all([
      get(TASK_SETTING_KEYS.restDays),
      get(TASK_SETTING_KEYS.digestHour),
      get(TASK_SETTING_KEYS.chaseTimes),
      get(TASK_SETTING_KEYS.claimGraceDays),
      get(TASK_SETTING_KEYS.tz),
    ]);
    const rest = await this.restDays();
    const hour = await this.digestHour();
    const times = parseChaseTimes(timesRaw);
    const grace = parseClaimGraceDays(graceRaw);
    const tz = tzRaw || 'Asia/Kolkata';
    return {
      tz: { value: tz, says: `Days, chase times and the digest all run on ${tz} time.` },
      chaseTimes: { value: times, says: `A new chase nudges at ${times.join(' and ')}.` },
      claimGraceDays: {
        value: grace,
        says: grace
          ? `If you haven't reviewed what someone says they finished for ${grace} day${grace === 1 ? '' : 's'}, the chase stops.`
          : 'A chase keeps going until you review it, however long that takes.',
      },
      restDays: {
        value: rest,
        says: rest.length ? `No reports are owed on ${rest.join(', ')}.` : 'Reports are owed every day of the week.',
      },
      digestHour: { value: hour, says: `The day closes at ${String(hour).padStart(2, '0')}:00 — anything not in by then is a miss.` },
      weekdays: WEEKDAYS,
    };
  }

  /** Save one or more of those rules. Anything absent is left alone. */
  async setTaskSettings(input: { chaseTimes?: unknown; claimGraceDays?: unknown; restDays?: unknown; digestHour?: unknown; tz?: unknown }) {
    const put = async (key: string, value: string) => {
      await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch((e) => this.log.warn(`setTaskSettings ${key}: ${e?.message}`));
    };
    if (input.chaseTimes !== undefined) {
      const clean = Array.isArray(input.chaseTimes) ? input.chaseTimes.filter((t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) : [];
      // Never store an empty set: a chase with no times never fires, which reads as "it's broken".
      await put(TASK_SETTING_KEYS.chaseTimes, JSON.stringify(clean.length ? [...new Set(clean)].sort() : TASK_DEFAULTS.chaseTimes));
    }
    if (input.claimGraceDays !== undefined) {
      const n = Number(input.claimGraceDays);
      await put(TASK_SETTING_KEYS.claimGraceDays, String(Number.isFinite(n) && n >= 0 && n <= 365 ? Math.floor(n) : 0));
    }
    if (input.tz !== undefined) {
      // Only a real IANA zone may be stored — a typo here would silently shift every day-key.
      const z = String(input.tz || '').trim();
      try {
        new Intl.DateTimeFormat('en', { timeZone: z });
        await put(TASK_SETTING_KEYS.tz, z);
      } catch {
        this.log.warn(`setTaskSettings tz: "${z}" is not a real timezone — ignored`);
      }
    }
    if (input.restDays !== undefined) await this.setRestDays(input.restDays);
    if (input.digestHour !== undefined) {
      const n = Number(input.digestHour);
      if (Number.isFinite(n) && n >= 0 && n <= 23) await put(TASK_SETTING_KEYS.digestHour, String(Math.floor(n)));
    }
    return this.taskSettings();
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
      .findMany({ where: { kind: 'recurring', status: TASK_OPEN, scheduleDays: null }, select: { id: true, title: true } })
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
        where: { kind: 'recurring', status: TASK_OPEN },
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
