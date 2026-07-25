import { matchesWhere, whereForDayRule } from './day-rule';

/**
 * BEA-1123: a recurring daily report is open by design and never leaves, so under the old rule it
 * appeared in EVERY day's record — Today, History, and every nightly AI prompt — forever. It is a
 * standing arrangement someone else owes, not your work for the day.
 */
describe('the day rule excludes standing daily reports', () => {
  const day = '2026-07-27';
  const start = new Date('2026-07-26T18:30:00Z');
  const end = new Date('2026-07-27T18:30:00Z');
  const where = whereForDayRule(day, start, end);

  it('keeps an ordinary open task on the day', () => {
    expect(matchesWhere({ day, status: 'open', kind: 'assignment', completedAt: null }, where)).toBe(true);
  });

  it('keeps a task with no kind set — nothing existing changed', () => {
    expect(matchesWhere({ day, status: 'open', completedAt: null }, where)).toBe(true);
  });

  it('drops a recurring report that would otherwise sit in every day forever', () => {
    expect(matchesWhere({ day, status: 'open', kind: 'recurring', completedAt: null }, where)).toBe(false);
  });

  it('drops it even on a day it was marked complete', () => {
    expect(matchesWhere({ day, status: 'done', kind: 'recurring', completedAt: new Date('2026-07-27T06:00:00Z') }, where)).toBe(false);
  });

  it('still keeps an assignment finished that day', () => {
    expect(matchesWhere({ day: '2026-07-01', status: 'done', kind: 'assignment', completedAt: new Date('2026-07-27T06:00:00Z') }, where)).toBe(true);
  });
});
