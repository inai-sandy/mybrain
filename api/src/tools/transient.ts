/**
 * A FLAKY VENDOR IS NOT A FAILED RUN (BEA-1496).
 *
 * His ESP32 agent asked Reddit for the top posts of the week and the whole run died on:
 *
 *     Reddit could not do that: Internal Server Error
 *
 * The exact same call, with the exact same arguments, worked seconds later when I made it by hand.
 * Nothing was wrong with the program, the arguments, or the account — the vendor had a bad moment,
 * and one bad moment threw away a run that had already been rebuilt three times.
 *
 * Every agent hits this eventually, so it belongs at the one call site rather than in each program.
 *
 * **Reads only.** That is the whole safety of it. A read can be repeated for ever with no
 * consequence. A write that answers 500 may well have *worked* — the vendor changed something and
 * then failed to tell us — and repeating it would create the page twice or send the message twice.
 * So a write that fails, fails, and the run reports it honestly.
 */

/** How many extra attempts a read gets. Small on purpose: this covers a blip, not an outage. */
export const RETRIES = 2;

/** Wait before each retry. Short enough that a run does not stall, long enough to clear a blip. */
export const BACKOFF_MS = [1200, 3500];

/**
 * Is this failure worth trying again?
 *
 * Matched on the vendor's own words and status, and deliberately NARROW. "Not found", "invalid
 * argument", "not connected" and "you need to sort by top to provide a timeframe" are all real
 * answers — repeating them wastes credits and hides the real problem. Only a fault on their side,
 * or the network between us, is worth a second go.
 */
export function isTransient(err: unknown, status?: number): boolean {
  const code = Number(status) || 0;
  // 5xx is theirs. 429 is theirs too — we asked too fast, and waiting is the correct response.
  if (code >= 500 && code < 600) return true;
  if (code === 429) return true;
  // A 4xx that is not 429 is our fault and will fail again identically.
  if (code >= 400 && code < 500) return false;

  const t = String((err as any)?.message ?? err ?? '').toLowerCase();
  if (!t) return false;
  return (
    t.includes('internal server error') ||
    t.includes('bad gateway') ||
    t.includes('service unavailable') ||
    t.includes('gateway timeout') ||
    t.includes('too many requests') ||
    t.includes('rate limit') ||
    t.includes('timeout') ||
    t.includes('timed out') ||
    t.includes('econnreset') ||
    t.includes('econnrefused') ||
    t.includes('etimedout') ||
    t.includes('socket hang up') ||
    t.includes('network error') ||
    t.includes('fetch failed')
  );
}

/**
 * The line the owner reads on the run when a retry saved it.
 *
 * Said out loud on purpose: a run that silently retried would hide a vendor that is degrading, and
 * "it worked, eventually" is a different fact from "it worked".
 */
export function retriedLine(actionId: string, attempt: number, why: string): string {
  const name = actionId.startsWith('svc:') ? actionId.slice(4) : actionId;
  return `${name} failed with "${String(why).slice(0, 80)}" — trying again (${attempt} of ${RETRIES})`;
}
