import { TasksService } from './tasks.service';

/**
 * Owner's rule: three chases with no reply means being ignored. Plus a promised date that passed,
 * and a claim he rejected. Reports only — nothing is auto-cancelled. (BEA-1030)
 */
function make(tasks: any[], replies: any[] = []) {
  const settings: Record<string, string> = {};
  const prisma: any = {
    setting: { findUnique: async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null) },
    task: { findMany: async () => tasks },
    reminderMessage: { findMany: async () => replies },
  };
  return new TasksService(prisma, {} as any, {} as any, { indexEntity: async () => undefined } as any) as any;
}

const ago = (d: number) => new Date(Date.now() - d * 86400000);
const base = (over: any = {}) => ({
  id: 't1', title: 'Send the vendor list', createdAt: ago(10), promisedFor: null, promiseSlips: 0,
  ownerContactId: 'c1', ownerContact: { id: 'c1', name: 'Ramesh' }, claims: [], chases: [], ...over,
});
const sends = (n: number, daysAgo = 1) => [{ sends: Array.from({ length: n }, () => ({ at: ago(daysAgo) })) }];

describe('stalling (BEA-1030)', () => {
  it('flags three chases with no reply', async () => {
    const r = await make([base({ chases: sends(3) })]).stalling();
    expect(r).toHaveLength(1);
    expect(r[0].why[0]).toBe('chased 3 times with no reply');
    expect(r[0].who).toBe('Ramesh');
  });

  it('does NOT flag two chases', async () => {
    expect(await make([base({ chases: sends(2) })]).stalling()).toHaveLength(0);
  });

  it('a reply resets it — chases before they answered do not count', async () => {
    const r = await make([base({ chases: sends(3, 5) })], [{ contactId: 'c1', createdAt: ago(1) }]).stalling();
    expect(r).toHaveLength(0);
  });

  it('counts only the chases sent SINCE they last replied', async () => {
    const chases = [{ sends: [{ at: ago(9) }, { at: ago(8) }, { at: ago(7) }, { at: ago(3) }, { at: ago(2) }, { at: ago(1) }] }];
    const r = await make([base({ chases })], [{ contactId: 'c1', createdAt: ago(5) }]).stalling();
    expect(r[0].unanswered).toBe(3);
  });

  it('flags a promised date that came and went', async () => {
    const past = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    const r = await make([base({ promisedFor: past })]).stalling();
    expect(r[0].why[0]).toContain('and it passed');
  });

  it('does NOT flag a promise still in the future', async () => {
    const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    expect(await make([base({ promisedFor: soon })]).stalling()).toHaveLength(0);
  });

  it('flags something they claimed and you rejected', async () => {
    const r = await make([base({ claims: [{ status: 'rejected', decidedAt: ago(1) }] })]).stalling();
    expect(r[0].why[0]).toContain("wasn't");
  });

  it('gives every reason at once when several apply', async () => {
    const past = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
    const r = await make([base({ chases: sends(4), promisedFor: past, claims: [{ status: 'rejected' }] })]).stalling();
    expect(r[0].why).toHaveLength(3);
  });

  it('puts the longest-open first', async () => {
    const r = await make([
      base({ id: 'a', title: 'newer', createdAt: ago(2), chases: sends(3) }),
      base({ id: 'b', title: 'older', createdAt: ago(30), chases: sends(3) }),
    ]).stalling();
    expect(r.map((x: any) => x.title)).toEqual(['older', 'newer']);
  });

  it('never reports work nobody owes', async () => {
    expect(await make([]).stalling()).toEqual([]);
  });
});
