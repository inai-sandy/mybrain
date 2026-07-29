import { TasksService } from './tasks.service';

/**
 * BEA-1185 — "remove duplicates" was folding a delegated task into one of the owner's own, and
 * tasks delegated to different people into each other. Merging moves chases, claims and the owner,
 * so a wrong group does real damage. Who a task belongs to is part of what it IS.
 */
function build(rows: any[], aiGroups: any[] = []) {
  const prisma: any = { task: { findMany: async () => rows } };
  const llm: any = { completeWith: async () => JSON.stringify({ groups: aiGroups }) };
  const prompts: any = { get: async () => 'TPL' };
  const svc: any = new TasksService(prisma, llm, prompts, {} as any);
  svc.getModel = async () => ({ provider: 'x', model: 'y' });
  svc.shape = (t: any) => t;
  return svc;
}

const mine = { id: 'a', title: 'send the monthly report', note: null, category: null, day: null, ownerContactId: null, party: null, createdAt: new Date(1) };
const hers = { id: 'b', title: 'send the monthly report', note: null, category: null, day: null, ownerContactId: 'c1', party: 'Madhuri', createdAt: new Date(2) };
const his = { id: 'c', title: 'send the monthly report', note: null, category: null, day: null, ownerContactId: 'c2', party: 'Jayanth', createdAt: new Date(3) };
const hers2 = { id: 'd', title: 'send the monthly report please', note: null, category: null, day: null, ownerContactId: 'c1', party: 'Madhuri', createdAt: new Date(4) };

describe('duplicates respect who the task belongs to (BEA-1185)', () => {
  it('never groups one of mine with one delegated to someone', async () => {
    const svc = build([mine, hers], [['a', 'b']]);
    const out = await svc.findDuplicates();
    expect(out.groups).toEqual([]);
  });

  it('never groups tasks delegated to two different people', async () => {
    const svc = build([hers, his], [['b', 'c']]);
    const out = await svc.findDuplicates();
    expect(out.groups).toEqual([]);
  });

  it('DOES still group two tasks delegated to the same person', async () => {
    const svc = build([hers, hers2], [['b', 'd']]);
    const out = await svc.findDuplicates();
    expect(out.groups.length).toBe(1);
    expect([out.groups[0].keep.id, ...out.groups[0].remove.map((r: any) => r.id)].sort()).toEqual(['b', 'd']);
  });

  it('DOES still group two of my own', async () => {
    const mine2 = { ...mine, id: 'e', createdAt: new Date(5) };
    const svc = build([mine, mine2], [['a', 'e']]);
    const out = await svc.findDuplicates();
    expect(out.groups.length).toBe(1);
  });

  it('holds even when the AI insists on a bad group — the guard is server-side', async () => {
    const svc = build([mine, hers, his], [['a', 'b', 'c']]);
    const out = await svc.findDuplicates();
    expect(out.groups).toEqual([]);
  });

  it('tells the AI who each task is delegated to', async () => {
    let seen = '';
    const prisma: any = { task: { findMany: async () => [mine, hers] } };
    const llm: any = { completeWith: async (_m: any, p: string) => { seen = p; return '{"groups":[]}'; } };
    const svc: any = new TasksService(prisma, llm, { get: async () => 'TPL' } as any, {} as any);
    svc.getModel = async () => ({});
    await svc.findDuplicates();
    expect(seen).toContain('Madhuri');
    expect(seen).toContain('delegatedTo');
  });
});

/**
 * The BEA-1185 sweep: the owner rule was enforced when duplicates were PROPOSED but not when they
 * were actually merged or removed — so a stale page, a retry, or any hand-made call could still
 * fold a delegated task into someone else's work. A rule that must always hold has to be enforced
 * where the change happens, not only where it is suggested.
 */
describe('the owner rule holds when the merge actually happens', () => {
  function mergeSvc(rows: any[]) {
    const updates: any[] = [];
    const deletes: any[] = [];
    const prisma: any = {
      task: {
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
        findMany: async ({ where }: any) => rows.filter((r) => (where.id?.in || []).includes(r.id) && r.id !== (where.id?.notIn || [])[0] && r.status === 'open'),
        update: async (a: any) => { updates.push(a); return rows[0]; },
        delete: async (a: any) => { deletes.push(a); return rows[0]; },
        deleteMany: async (a: any) => { deletes.push(a); return { count: (a.where.id?.in || []).length }; },
      },
      reminder: { count: async () => 0, updateMany: async () => ({}) },
      taskClaim: { updateMany: async () => ({}) },
      taskPerson: { findMany: async () => [], createMany: async () => ({}) },
    };
    const svc: any = new TasksService(prisma, {} as any, {} as any, {} as any);
    svc.indexTask = () => undefined; svc.unindexTask = () => undefined; svc.shape = (t: any) => t;
    return { svc, updates, deletes };
  }

  const mineOpen = { id: 'a', title: 'send the report', status: 'open', ownerContactId: null, party: null, progress: 0 };
  const hersOpen = { id: 'b', title: 'send the report', status: 'open', ownerContactId: 'c1', party: 'Madhuri', progress: 0 };

  it('refuses to merge a delegated task onto one of mine, even when told to', async () => {
    const { svc, deletes } = mergeSvc([mineOpen, hersOpen]);
    const out = await svc.mergeDuplicates([{ keepId: 'a', removeIds: ['b'] }]);
    expect(out.merged).toBe(0);
    expect(deletes.length).toBe(0);
  });

  it('keeps a delegated task out of a duplicate REMOVAL, and says which', async () => {
    const { svc } = mergeSvc([mineOpen, hersOpen]);
    const out = await svc.removeDuplicates(['a', 'b']);
    expect(out.keptDelegated).toEqual(['send the report']); // hers survived
    expect(out.removed).toBe(1); // only mine went
  });
});
