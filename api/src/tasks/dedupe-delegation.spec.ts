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
