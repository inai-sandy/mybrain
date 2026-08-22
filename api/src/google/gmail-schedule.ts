/**
 * When Gmail is read — and the arithmetic "today" is counted with. (BEA-1399)
 *
 * The owner's rule: Gmail is touched at two local times a day and at no other time in the
 * background. Composio counts every call, so a probe that nobody reads is money. These numbers are
 * a product decision; the ticker in `gmail-brief.service.ts` and the usage line in the UI both read
 * them from here so they can never disagree.
 */
export const EARLY_AT = '21:00'; // the early brief — the full read of the day
export const FINAL_AT = '23:30'; // the final pass — only what arrived after the early read

export type NextWindow = { time: string; day: 'today' | 'tomorrow' };

/** The next scheduled read, from the local clock ("HH:MM"). */
export function nextWindow(hm: string): NextWindow {
  if (hm < EARLY_AT) return { time: EARLY_AT, day: 'today' };
  if (hm < FINAL_AT) return { time: FINAL_AT, day: 'today' };
  return { time: EARLY_AT, day: 'tomorrow' };
}

/**
 * The instant local midnight happened in `tz` for the day `now` falls in — the start of "today" for
 * the call counter. A zone the runtime cannot resolve falls back to UTC midnight rather than throwing:
 * a wrong counter start is better than no counter. The offset is read at `now`, so in a zone WITH
 * daylight saving the answer can be an hour off on the one day a year the clocks change (IST, the
 * default, has none) — a counter an hour long or short for one day, never a missed read.
 */
export function startOfLocalDay(tz: string, now: Date = new Date()): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    // The wall-clock in tz, read as if it were UTC; the difference to `now` is the zone offset.
    const wallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    const offsetMs = wallAsUtc - Math.floor(now.getTime() / 1000) * 1000;
    const midnightWallAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'));
    return new Date(midnightWallAsUtc - offsetMs);
  } catch {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
}
