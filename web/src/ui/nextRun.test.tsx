import { describe, expect, it } from 'vitest';
import { nextRunWords, scheduleLine } from './nextRun';

/**
 * WHEN DOES IT NEXT RUN, IN HIS TIME? (BEA-1508)
 *
 * Rows said "Every day at 22:00" and never said when that was next, or whose 22:00. The server runs
 * on UTC, five and a half hours behind him, and that gap already cost one real bug (BEA-1486).
 *
 * `now` is passed in, so these are real assertions rather than something that changes at 10pm.
 */
const IST = 'Asia/Kolkata';
// 18:00 UTC = 23:30 IST — deliberately an instant where the UTC day and his day disagree.
const at1800utc = new Date('2026-08-27T18:00:00Z');
// 10:00 UTC = 15:30 IST, same day both ways.
const at1000utc = new Date('2026-08-27T10:00:00Z');

describe('the next run, on his clock', () => {
  it('says today when the time has not passed where HE is', () => {
    expect(nextRunWords({ every: 'day', at: '22:00' }, IST, at1000utc)).toBe('next: today 22:00');
  });

  it('says tomorrow once his 22:00 has gone by — even though it is still 18:00 in UTC', () => {
    // The whole point: read on the server's clock this would wrongly say "today".
    expect(nextRunWords({ every: 'day', at: '22:00' }, IST, at1800utc)).toBe('next: tomorrow 22:00');
  });

  it('handles a weekly schedule by name', () => {
    // 27 Aug 2026 is a Thursday in IST.
    expect(nextRunWords({ every: 'week', dow: 1, at: '08:00' }, IST, at1000utc)).toBe('next: Monday 08:00');
    expect(nextRunWords({ every: 'week', dow: 5, at: '08:00' }, IST, at1000utc)).toBe('next: tomorrow 08:00');
  });

  it('a weekly slot that has already passed today is next week, not in a moment', () => {
    // Thursday 08:00 IST, asked at 15:30 IST.
    expect(nextRunWords({ every: 'week', dow: 4, at: '08:00' }, IST, at1000utc)).toBe('next: Thursday 08:00');
  });

  it('says nothing rather than guessing', () => {
    // A wrong "next run" is worse than none — he would plan around it.
    expect(nextRunWords(null, IST, at1000utc)).toBe('');
    expect(nextRunWords({ every: 'day' }, IST, at1000utc)).toBe('');
    expect(nextRunWords({ every: 'month', at: '09:00' }, IST, at1000utc)).toBe('');
    expect(nextRunWords({ every: 'week', at: '09:00' }, IST, at1000utc)).toBe('');
    expect(nextRunWords({ every: 'day', at: '99:99' }, IST, at1000utc)).toBe('');
    expect(nextRunWords({ every: 'day', at: '22:00' }, 'Not/AZone', at1000utc)).toBe('');
  });
});

describe('the whole schedule line', () => {
  it('names the zone, because a time with no zone is the ambiguity that caused a real bug', () => {
    expect(scheduleLine('Every day at 22:00', { every: 'day', at: '22:00' }, IST, at1000utc))
      .toBe('Every day at 22:00 · Asia/Kolkata · next: today 22:00');
  });

  it('is quiet for an agent with no schedule at all', () => {
    expect(scheduleLine('', null, IST, at1000utc)).toBe('');
    expect(scheduleLine(null, null, IST, at1000utc)).toBe('');
  });

  it('still gives the words when the next run cannot be worked out', () => {
    expect(scheduleLine('Manual only', null, IST, at1000utc)).toBe('Manual only · Asia/Kolkata');
  });
});
