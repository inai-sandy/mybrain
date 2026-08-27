/**
 * WHEN DOES IT NEXT RUN, IN HIS TIME? (BEA-1508)
 *
 * Rows say "Every day at 22:00" and never say *when that is next*. Worse, they never say whose 22:00
 * — the server runs on UTC, five and a half hours behind him, and that has already cost one real bug
 * (BEA-1486: every program computed "today" on the wrong clock). A schedule you cannot check is a
 * schedule you have to trust.
 *
 * Pure, and takes `now` so it can be tested without waiting until tomorrow.
 */

export type Schedule = { every?: string; at?: string; dow?: number } | null;

/** The parts of an instant, as they read in a given zone. */
function partsIn(at: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  });
  const got: Record<string, string> = {};
  for (const p of f.formatToParts(at)) got[p.type] = p.value;
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(got.year), m: Number(got.month), d: Number(got.day),
    // "24" at midnight is a real thing Intl returns with hour12:false.
    hh: Number(got.hour) % 24, mm: Number(got.minute), dow: DOW[got.weekday] ?? 0,
  };
}

/**
 * How many minutes past midnight it is, where he is.
 *
 * Comparing "now" with "22:00" only means something once both are read on the same clock, which is
 * the whole reason this file exists.
 */
function minutesNow(now: Date, tz: string): number {
  const p = partsIn(now, tz);
  return p.hh * 60 + p.mm;
}

function minutesOf(at?: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

const DAY_NAME = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * "next: tomorrow 22:00" — in his words, on his clock.
 *
 * Returns an empty string when there is nothing honest to say: no schedule, no time, or a repeat
 * pattern this does not understand. A wrong "next run" is worse than none, because he would plan
 * around it.
 */
export function nextRunWords(schedule: Schedule, tz: string, now: Date = new Date()): string {
  const at = minutesOf(schedule?.at);
  if (!schedule || !at && at !== 0) return '';
  const zone = String(tz || '').trim() || 'UTC';

  let here;
  try {
    here = partsIn(now, zone);
  } catch {
    return ''; // an unknown zone is not something to guess about
  }
  const mins = minutesNow(now, zone);
  const clock = String(schedule.at);

  if (schedule.every === 'day') {
    return mins < at ? `next: today ${clock}` : `next: tomorrow ${clock}`;
  }

  if (schedule.every === 'week') {
    const want = Number(schedule.dow);
    if (!Number.isInteger(want) || want < 0 || want > 6) return '';
    let days = (want - here.dow + 7) % 7;
    // Today, but the moment has already passed → it is next week, not in a minute's time.
    if (days === 0 && mins >= at) days = 7;
    if (days === 0) return `next: today ${clock}`;
    if (days === 1) return `next: tomorrow ${clock}`;
    return `next: ${DAY_NAME[want]} ${clock}`;
  }

  return '';
}

/**
 * The schedule line with its zone named, e.g. "Every day at 22:00 · Asia/Kolkata · next: today 22:00".
 *
 * The zone is stated because the server's clock is not his, and a time with no zone is exactly the
 * ambiguity that produced dated pages one day out.
 */
export function scheduleLine(scheduleText: string | null | undefined, schedule: Schedule, tz: string, now: Date = new Date()): string {
  const words = String(scheduleText || '').trim();
  if (!words) return '';
  const next = nextRunWords(schedule, tz, now);
  const zone = String(tz || '').trim();
  return [words, zone || null, next || null].filter(Boolean).join(' · ');
}
