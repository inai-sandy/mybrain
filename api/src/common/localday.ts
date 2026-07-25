/**
 * The owner's local day, in one place (BEA-1117).
 *
 * Everything about a recurring report is decided per LOCAL day — "did today's status arrive?",
 * "is today a rest day?", "which day did we miss?" — so the day key and the weekday it falls on
 * must mean exactly the same thing to the scheduler, the agent and the end-of-day summary.
 */

/** Minutes east of UTC for the owner's timezone (IST = +330). Configurable. (BEA-734) */
export const TZ_OFFSET_MIN = Number(process.env.REMINDER_TZ_OFFSET_MINUTES) || 330;

/** Local day key YYYY-MM-DD. e.g. 04:00 UTC → the same date in IST, 03:00 UTC → still that date. */
export function localDayKey(now: Date = new Date(), offsetMin = TZ_OFFSET_MIN): string {
  return new Date(now.getTime() + offsetMin * 60000).toISOString().slice(0, 10);
}

const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Which weekday a local day key falls on, as 'Sun'…'Sat'. The key is treated as a plain calendar
 * date (parsed at UTC midnight), so the answer can't drift with the server's own timezone.
 */
export function weekdayOf(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : NAMES[d.getUTCDay()];
}

/** The day key N days before the given one. Used to walk back over a run of days. */
export function dayKeyBefore(dayKey: string, days = 1): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
