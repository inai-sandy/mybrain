import { parseChaseTimes, parseClaimGraceDays, claimGraceExpired, TASK_DEFAULTS } from './task-settings';

/**
 * BEA-1160/1161. The owner's rule: "If I am not marking it as done for two straight days, then you
 * can stop it." That is the ONLY time-based stop, and every default here has to fail in the safe
 * direction — a chase running one day too long costs a nudge; one ending early loses the work.
 */
describe('the chase rules he controls', () => {
  it('falls back to the standard slots rather than to no chase at all', () => {
    expect(parseChaseTimes(null)).toEqual(TASK_DEFAULTS.chaseTimes);
    expect(parseChaseTimes('not json')).toEqual(TASK_DEFAULTS.chaseTimes);
    expect(parseChaseTimes('[]')).toEqual(TASK_DEFAULTS.chaseTimes);
    expect(parseChaseTimes('["25:00","later"]')).toEqual(TASK_DEFAULTS.chaseTimes);
  });

  it('keeps the times he set, in order, without duplicates', () => {
    expect(parseChaseTimes('["17:30","09:00","09:00"]')).toEqual(['09:00', '17:30']);
  });

  it('defaults the grace period to his two days', () => {
    expect(parseClaimGraceDays(null)).toBe(2);
    expect(parseClaimGraceDays('')).toBe(2);
    expect(parseClaimGraceDays('3')).toBe(3);
  });

  it('treats nonsense as "never stop" — waiting for him beats stopping early', () => {
    expect(parseClaimGraceDays('abc')).toBe(0);
    expect(parseClaimGraceDays('-1')).toBe(0);
    expect(parseClaimGraceDays('9999')).toBe(0);
  });

  it('0 means never, and never really means never', () => {
    const longAgo = new Date('2020-01-01');
    expect(claimGraceExpired(longAgo, 0)).toBe(false);
  });
});

describe('when a claim has waited too long', () => {
  const now = new Date('2026-07-28T10:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000);

  it('two full days is the trigger', () => {
    expect(claimGraceExpired(daysAgo(2), 2, now)).toBe(true);
    expect(claimGraceExpired(daysAgo(1.9), 2, now)).toBe(false);
  });

  it('a claim from this morning is nowhere near', () => {
    expect(claimGraceExpired(daysAgo(0), 2, now)).toBe(false);
  });

  it('a broken timestamp never stops a chase', () => {
    expect(claimGraceExpired('not a date' as any, 2, now)).toBe(false);
  });
});
