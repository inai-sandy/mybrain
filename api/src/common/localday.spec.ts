import { dayKeyBefore, localDayKey, weekdayOf } from './localday';

/**
 * BEA-1117: everything about a recurring report is decided per LOCAL day — did today's status
 * arrive, is today a rest day, which day did we miss. If the scheduler and the ledger disagree
 * about when a day starts, a report is chased twice or logged missed on a day nobody owed it.
 */
describe('localDayKey — the owner\'s day, not the server\'s', () => {
  it('late-evening IST is still the same local day, not tomorrow', () => {
    // 2026-07-25 18:30 UTC = 2026-07-26 00:00 IST — the local day has just turned over
    expect(localDayKey(new Date('2026-07-25T18:30:00Z'))).toBe('2026-07-26');
  });

  it('just before the IST rollover is still today', () => {
    expect(localDayKey(new Date('2026-07-25T18:29:00Z'))).toBe('2026-07-25');
  });

  it('early-morning UTC is already the IST day', () => {
    expect(localDayKey(new Date('2026-07-25T04:00:00Z'))).toBe('2026-07-25');
  });
});

describe('weekdayOf — which day a key falls on', () => {
  it('names the weekday from a plain date key', () => {
    expect(weekdayOf('2026-07-26')).toBe('Sun');
    expect(weekdayOf('2026-07-25')).toBe('Sat');
    expect(weekdayOf('2026-07-27')).toBe('Mon');
  });

  it('does not drift with the server timezone (parsed as a calendar date)', () => {
    expect(weekdayOf('2026-01-01')).toBe('Thu');
  });

  it('returns empty for nonsense rather than guessing', () => {
    expect(weekdayOf('not-a-date')).toBe('');
  });
});

describe('dayKeyBefore — walking back over days', () => {
  it('steps back one day', () => {
    expect(dayKeyBefore('2026-07-25')).toBe('2026-07-24');
  });

  it('crosses a month boundary', () => {
    expect(dayKeyBefore('2026-08-01')).toBe('2026-07-31');
  });

  it('steps back several days', () => {
    expect(dayKeyBefore('2026-07-25', 7)).toBe('2026-07-18');
  });
});
