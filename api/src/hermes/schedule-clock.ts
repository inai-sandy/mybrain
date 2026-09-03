import { Logger } from '@nestjs/common';
import { opsAlertIfPlumbing } from '../push/ops-alert';

/**
 * Protect the clock (BEA-1605) — the ONE helper both minute-tickers share.
 *
 * `AgentScheduler` and `FlowScheduler` each tick every 60 s. Before this, the tick was
 * `this.tick().catch(() => undefined)` — a throw was swallowed with no log line — and the timezone
 * came straight from Setting `tasks.tz` into `Intl.DateTimeFormat`. A zone name Intl rejects
 * ("Asia/Kolkatta") threw a RangeError on EVERY tick, so every scheduled agent and flow stopped,
 * silently, forever. Two rules, written once:
 *
 *  - `safeTz()` — a zone Intl accepts is used as-is; anything else falls back to `DEFAULT_TZ`, says
 *    so in the log ONCE per (scheduler, bad value) and phones home ONCE through the ops-alert seam
 *    (classified by `failure-words.ts` — `bad-timezone` — never a hand-named class here).
 *  - `guardedTick()` — runs one tick; a throw is logged ONCE per distinct message (a 60 s ticker
 *    would otherwise flood the log with the same line) and the next tick still runs. A tick that
 *    completes forgets what it saw, so the same failure after a recovery is said again.
 *
 * Nothing here touches `matches()`, the look-back, `markFired` or the lock skip — only what happens
 * around the tick and where its zone comes from.
 */

export const DEFAULT_TZ = 'Asia/Kolkata';

/** Does Intl know this zone? The same check the tick's formatter would fail on. */
export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The honest internal sentence for a rejected zone. `failure-words.ts` classifies it (`bad-timezone`),
 * so the words here and the classifier's regex are locked together by `schedule-clock.spec.ts`.
 */
export function badTimezoneSentence(bad: string): string {
  return `the timezone setting "${bad}" is not a zone name the clock recognises — running on ${DEFAULT_TZ} until it is fixed`;
}

/** `<scheduler>|<bad value>` already warned about — in memory, once per process. */
const warnedTz = new Set<string>();
/** `<scheduler>` → the distinct tick-failure messages already logged since its last good tick. */
const seenTickErrors = new Map<string, Set<string>>();
/** Never let one wedged scheduler grow the set without bound — after this many, start over. */
const MAX_DISTINCT_TICK_ERRORS = 50;

/** Tests only: forget every warning and error already said. */
export function resetScheduleClock(): void {
  warnedTz.clear();
  seenTickErrors.clear();
}

/**
 * The zone the tick runs in. `setting` is the raw Setting value (or nothing — no row, a failed
 * read); `name` is the scheduler saying it, so each ticker warns once in its own log.
 */
export function safeTz(setting: unknown, name: string, log: Logger): string {
  const raw = typeof setting === 'string' ? setting.trim() : '';
  if (!raw) return DEFAULT_TZ;
  if (isValidTz(raw)) return raw;
  const key = `${name}|${raw}`;
  if (!warnedTz.has(key)) {
    if (warnedTz.size >= MAX_DISTINCT_TICK_ERRORS) warnedTz.clear(); // the same bound as the tick errors
    warnedTz.add(key);
    const why = badTimezoneSentence(raw);
    log.warn(why);
    opsAlertIfPlumbing(why); // no agent, no run: one alert a day for the whole app, keyed on the class alone
  }
  return DEFAULT_TZ;
}

/**
 * Run one tick. Never throws; never silent. The first time a given failure message is seen it is
 * logged with its stack; the same message again is not (the flood guard). A tick that completes
 * clears the memory, so a failure that comes back after a recovery is logged afresh.
 */
export async function guardedTick(name: string, log: Logger, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    seenTickErrors.delete(name);
  } catch (e: any) {
    const msg = String(e?.message || e || 'unknown error');
    let seen = seenTickErrors.get(name);
    if (!seen) {
      seen = new Set();
      seenTickErrors.set(name, seen);
    }
    if (seen.has(msg)) return;
    if (seen.size >= MAX_DISTINCT_TICK_ERRORS) seen.clear();
    seen.add(msg);
    try {
      log.error(`${name} tick failed: ${msg} — the next tick still runs`, e?.stack);
    } catch {
      /* a logger that throws must not become an unhandled rejection out of the timer */
    }
  }
}
