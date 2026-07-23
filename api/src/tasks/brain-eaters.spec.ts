import { TasksService } from './tasks.service';

/**
 * Brain Eaters (BEA-1056): a separate home for the things that circle the owner's head —
 * auto-spotted from tasks that keep rolling over, moved only on his confirm, dumped his way.
 */
function make(rows: any[] = [], llmReply: string | null = null) {
  const created: any[] = [];
  const updates: any[] = [];
  let seq = 0;
  const prisma: any = {
    task: {
      findMany: async ({ where }: any) => {
        if (where?.brainEater === true) return rows.filter((r) => r.brainEater);
        if (where?.brainEater === false) return rows.filter((r) => !r.brainEater && r.status === 'open' && (r.rolloverCount || 0) >= where.rolloverCount.gte);
        return rows;
      },
      updateMany: async ({ where, data }: any) => { updates.push({ ids: where.id.in, ...data }); return { count: where.id.in.length }; },
      update: async ({ where, data }: any) => { updates.push({ ids: [where.id], ...data }); return {}; },
      create: async ({ data }: any) => { const t = { id: `t${++seq}`, ...data }; created.push(t); return t; },
      findFirst: async () => null,
      count: async () => 0,
    },
    setting: { findUnique: async () => null, upsert: async () => ({}) },
    contact: { findMany: async () => [] }, // create() resolves owners/mentions against contacts
    brainDump: { create: async ({ data }: any) => ({ id: 'bd1', ...data }) },
    memoryOutbox: { deleteMany: async () => ({}) },
  };
  const llm: any = { completeWith: async () => llmReply };
  const prompts: any = { get: async () => 'PROMPT' };
  const memory: any = { enqueue: async () => undefined, deleteDoc: async () => undefined, indexEntity: async () => undefined };
  const svc = new TasksService(prisma, llm, prompts, memory);
  return { svc, created, updates };
}

describe('Brain Eaters (BEA-1056)', () => {
  it('lists eaters open-first and spots candidates carried 4+ days', async () => {
    const rows = [
      { id: 'a', title: 'Done eater', brainEater: true, status: 'done', rolloverCount: 0 },
      { id: 'b', title: 'Open eater', brainEater: true, status: 'open', rolloverCount: 2 },
      { id: 'c', title: 'Slipping for a week', brainEater: false, status: 'open', rolloverCount: 6 },
      { id: 'd', title: 'Fresh task', brainEater: false, status: 'open', rolloverCount: 1 },
    ];
    const { svc } = make(rows);
    const r = await svc.brainEaters();
    expect(r.tasks[0].id).toBe('b'); // open before done
    expect(r.openCount).toBe(1);
    expect(r.candidates).toEqual([{ id: 'c', title: 'Slipping for a week', carried: 6 }]); // 'd' is too fresh
  });

  it('mark and un-mark are explicit, by id', async () => {
    const { svc, updates } = make();
    await svc.markBrainEater(['x', 'y'], true);
    await svc.markBrainEater(['x'], false);
    expect(updates[0]).toMatchObject({ ids: ['x', 'y'], brainEater: true });
    expect(updates[1]).toMatchObject({ ids: ['x'], brainEater: false });
  });

  it('a dump splits into separate eaters via the AI', async () => {
    const reply = JSON.stringify({ tasks: [{ title: 'Renew the insurance' }, { title: 'Call the CA about the filing' }] });
    const { svc, created, updates } = make([], reply);
    const r = await svc.dumpBrainEaters('insurance keeps nagging, and the CA call');
    expect(r.created).toBe(2);
    expect(created.map((c) => c.title)).toEqual(['Renew the insurance', 'Call the CA about the filing']);
    expect(updates.filter((u) => u.brainEater === true)).toHaveLength(2); // each flagged after creation
  });

  it('the AI being down never eats his words — one eater holds the whole dump', async () => {
    const { svc, created } = make([], null);
    const r = await svc.dumpBrainEaters('the broken factory door keeps circling my head');
    expect(r.created).toBe(1);
    expect(created[0].title).toContain('broken factory door');
  });
});
