import { matchesWhere } from './day-rule';

/**
 * The personal board must never show work handed to someone else, and the delegated view must
 * never show the owner's own work. If those two mix, neither list can be trusted. (BEA-1029)
 */
describe('the personal board excludes delegated work (BEA-1029)', () => {
  const start = new Date('2026-07-21T00:00:00Z');
  const end = new Date('2026-07-22T00:00:00Z');
  const rule = (extra: any) => ({ AND: [{ OR: [{ day: { lte: '2026-07-21' }, OR: [{ status: { not: 'done' } }, { completedAt: { gte: end } }] }] }, extra] });

  const mine = { id: 'a', day: '2026-07-21', status: 'open', ownerContactId: null, completedAt: null };
  const theirs = { id: 'b', day: '2026-07-21', status: 'open', ownerContactId: 'c1', completedAt: null };

  it('keeps the owner’s own task', () => {
    expect(matchesWhere(mine, rule({ ownerContactId: null }))).toBe(true);
  });

  it('drops a task owned by a contact', () => {
    expect(matchesWhere(theirs, rule({ ownerContactId: null }))).toBe(false);
  });
});
