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

/**
 * BEA-1123: a standing daily report is never finished, so it would sit in Delegated forever,
 * inflate the count, age meaninglessly, and — because its claims had to be rejected before
 * BEA-1118 — read as "said it was done, but it wasn't". It belongs in its own tab, not here.
 */
describe('recurring reports are not delegated work', () => {
  it('asks the database for assignments only', async () => {
    let asked: any = null;
    const prisma: any = {
      task: { findMany: async (q: any) => { asked = q.where; return []; } },
      reminderMessage: { findMany: async () => [] },
      setting: { findUnique: async () => null },
    };
    const svc: any = new (require('./tasks.service').TasksService)(prisma, {} as any, {} as any, {} as any);
    await svc.delegated().catch(() => undefined);
    expect(asked?.kind).toEqual({ not: 'recurring' });
  });

  it('excludes them from stalling too — a daily report can never be stalled', async () => {
    let asked: any = null;
    const prisma: any = {
      task: { findMany: async (q: any) => { asked = q.where; return []; } },
      reminderMessage: { findMany: async () => [] },
      setting: { findUnique: async () => null },
    };
    const svc: any = new (require('./tasks.service').TasksService)(prisma, {} as any, {} as any, {} as any);
    await svc.stalling().catch(() => undefined);
    expect(asked?.kind).toEqual({ not: 'recurring' });
  });
});
