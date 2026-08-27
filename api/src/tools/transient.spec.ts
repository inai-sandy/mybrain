import { BACKOFF_MS, RETRIES, isTransient, retriedLine } from './transient';

/**
 * A FLAKY VENDOR IS NOT A FAILED RUN (BEA-1496).
 *
 * His ESP32 agent died on "Reddit could not do that: Internal Server Error". The identical call, with
 * the identical arguments, worked seconds later by hand — proven live before this was written. One
 * bad moment at the vendor threw away a run that had already been rebuilt three times.
 */
describe('what is worth trying again', () => {
  it('retries the exact failure that killed his run', () => {
    expect(isTransient('Reddit could not do that: Internal Server Error')).toBe(true);
  });

  it('retries the vendor’s own faults and the network between us', () => {
    for (const e of ['Bad Gateway', 'Service Unavailable', 'gateway timeout', 'socket hang up', 'ECONNRESET', 'fetch failed', 'Rate limit exceeded']) {
      expect(isTransient(e)).toBe(true);
    }
    expect(isTransient('boom', 503)).toBe(true);
    expect(isTransient('slow down', 429)).toBe(true);
  });

  it('does NOT retry a real answer — that wastes credits and hides the cause', () => {
    // Every one of these is the vendor telling us something true. Repeating it changes nothing.
    for (const e of [
      "You need to sort by 'top' to provide a timeframe",   // the real Reddit message, seen live
      'not_found',
      'Invalid request data provided',
      'Following fields are missing: {parent_id}',
      'This account is not connected',
    ]) {
      expect(isTransient(e)).toBe(false);
    }
    expect(isTransient('bad request', 400)).toBe(false);
    expect(isTransient('forbidden', 403)).toBe(false);
    expect(isTransient('gone', 404)).toBe(false);
  });

  it('says nothing is retryable when there is nothing to read', () => {
    expect(isTransient('')).toBe(false);
    expect(isTransient(null)).toBe(false);
    expect(isTransient(undefined)).toBe(false);
  });

  it('a 4xx wins over words that look transient', () => {
    // A 400 whose body happens to say "timeout" is still our fault and will fail again identically.
    expect(isTransient('request timeout field invalid', 400)).toBe(false);
  });

  it('has one backoff per retry, and stays short enough not to stall a run', () => {
    expect(BACKOFF_MS).toHaveLength(RETRIES);
    expect(BACKOFF_MS.reduce((a, b) => a + b, 0)).toBeLessThan(10_000);
  });

  it('tells the owner it happened, in the vendor’s own words', () => {
    // A silent retry would hide a vendor that is degrading. "It worked eventually" is its own fact.
    const line = retriedLine('svc:reddit.subreddit', 1, 'Internal Server Error');
    expect(line).toContain('reddit.subreddit');
    expect(line).toContain('Internal Server Error');
    expect(line).toContain(`1 of ${RETRIES}`);
  });
});

/**
 * The safety rule, asserted on the real source: only a READ may be repeated. A write that answers
 * 500 may have actually worked, and repeating it would create the page twice or send twice.
 */
describe('only reads are repeated', () => {
  const src = () => require('fs').readFileSync(require('path').join(__dirname, 'service-actions.service.ts'), 'utf8');

  it('decides repeatability from the catalog, not from the error', () => {
    const t = src();
    expect(t).toMatch(/const repeatable = p\.readOnly === true \|\| String\(action\.method[\s\S]{0,120}isReadAction\(actionId, service\)/);
  });

  it('stops retrying the moment it succeeds, or the call is not repeatable', () => {
    expect(src()).toContain('if (res?.ok || !repeatable || !isTransient(');
  });
});
