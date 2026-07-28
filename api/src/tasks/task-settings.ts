/**
 * The rules that decide how the owner's team gets chased — his to set, not ours to hardcode.
 * (BEA-1161)
 *
 * Every one of these existed before as a number buried in code, or as an API endpoint with no
 * screen behind it. He could not change his own rest days without someone calling the API for him.
 * That is why the app kept behaving as though it held opinions he never gave it.
 *
 * A default in code is fine. A value he cannot see or change is not.
 */

export const TASK_SETTING_KEYS = {
  /** Local HH:MM slots a new chase uses when he named no time. */
  chaseTimes: 'tasks.chaseTimes',
  /**
   * A claim sitting unreviewed this many days stops the chase — his inaction reads as acceptance.
   * 0 means never: keep the chase alive until he decides. (BEA-1160)
   */
  claimGraceDays: 'tasks.claimGraceDays',
  /** Weekdays on which no standing report is owed. */
  restDays: 'recurring.restDays',
  /** The hour after which a day is closed and the miss summary goes out. */
  digestHour: 'recurring.digestHour',
} as const;

export const TASK_DEFAULTS = {
  chaseTimes: ['10:00', '17:30'],
  /** Two days, the owner's rule: "If I am not marking it as done for two straight days, then you can stop it." */
  claimGraceDays: 2,
  restDays: ['Sun'],
  digestHour: 20,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Parse stored chase times, falling back to the default rather than to no chase at all. */
export function parseChaseTimes(raw: string | null | undefined): string[] {
  try {
    const a = JSON.parse(String(raw || ''));
    const clean = [...new Set((Array.isArray(a) ? a : []).filter((t) => typeof t === 'string' && HHMM.test(t)))] as string[];
    return clean.length ? clean.sort().slice(0, 8) : TASK_DEFAULTS.chaseTimes;
  } catch {
    return TASK_DEFAULTS.chaseTimes;
  }
}

/**
 * How many days an unreviewed claim may sit before the chase stops. Anything unreadable falls back
 * to the default; a negative or absurd number is treated as "never", because the failure that costs
 * him is a chase ending early, not one running long.
 */
export function parseClaimGraceDays(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || String(raw).trim() === '') return TASK_DEFAULTS.claimGraceDays;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 365) return 0; // 0 = never stop; wait for him
  return Math.floor(n);
}

/** Has a claim sat unreviewed long enough for the chase to stop? `graceDays: 0` means never. */
export function claimGraceExpired(claimedAt: Date | string, graceDays: number, now: Date = new Date()): boolean {
  if (!graceDays) return false;
  const t = new Date(claimedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t >= graceDays * 86400000;
}
