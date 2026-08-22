import { EARLY_AT, FINAL_AT, nextWindow, startOfLocalDay } from './gmail-schedule';

/**
 * Gmail is read at exactly two local times a day (BEA-1399): the early brief and the final pass.
 * These are the owner's numbers — a change here is a product decision, not a tidy-up.
 */
describe('Gmail schedule (BEA-1399)', () => {
  it('the two windows are 21:00 and 23:30 local', () => {
    expect(EARLY_AT).toBe('21:00');
    expect(FINAL_AT).toBe('23:30');
  });

  it('names the next read from the local clock', () => {
    expect(nextWindow('08:15')).toEqual({ time: '21:00', day: 'today' });
    expect(nextWindow('21:00')).toEqual({ time: '23:30', day: 'today' });
    expect(nextWindow('22:59')).toEqual({ time: '23:30', day: 'today' });
    expect(nextWindow('23:30')).toEqual({ time: '21:00', day: 'tomorrow' });
    expect(nextWindow('23:59')).toEqual({ time: '21:00', day: 'tomorrow' });
  });

  it('finds local midnight for the owner\'s zone, so "today\'s calls" are counted from the right instant', () => {
    // 2026-08-22 10:30 UTC = 16:00 IST → IST midnight was 2026-08-21T18:30:00Z.
    const now = new Date('2026-08-22T10:30:00Z');
    expect(startOfLocalDay('Asia/Kolkata', now).toISOString()).toBe('2026-08-21T18:30:00.000Z');
    // 2026-08-22 20:00 UTC = 01:30 IST next day → midnight is 2026-08-22T18:30:00Z.
    expect(startOfLocalDay('Asia/Kolkata', new Date('2026-08-22T20:00:00Z')).toISOString()).toBe('2026-08-22T18:30:00.000Z');
    // A zone we cannot resolve falls back to UTC midnight instead of throwing.
    expect(startOfLocalDay('Nowhere/Nope', now).toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });
});
