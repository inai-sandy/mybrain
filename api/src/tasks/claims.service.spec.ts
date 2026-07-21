import { ClaimsService } from './claims.service';

/**
 * The one rule everything else rests on: a claim is NOT a completion. Nothing in here may ever
 * change a task's status. (BEA-1024)
 */
function make(tasks: any[]) {
  const claims: any[] = [];
  let seq = 0;
  const prisma: any = {
    task: { findUnique: async ({ where }: any) => tasks.find((t) => t.id === where.id) || null },
    taskClaim: {
      create: async ({ data }: any) => { const r = { id: `k${++seq}`, status: 'pending', createdAt: new Date(), ...data }; claims.push(r); return r; },
      findFirst: async ({ where }: any) => claims.find((c) => c.taskId === where.taskId && c.status === where.status) || null,
      findMany: async ({ where }: any) => claims.filter((c) => c.status === where.status && (!where.taskId?.in || where.taskId.in.includes(c.taskId))),
      count: async ({ where }: any) => claims.filter((c) => c.taskId === where.taskId && c.status === where.status).length,
      update: async ({ where, data }: any) => { const c = claims.find((x) => x.id === where.id); Object.assign(c, data); return c; },
      delete: async ({ where }: any) => { const i = claims.findIndex((x) => x.id === where.id); return claims.splice(i, 1)[0]; },
      findUnique: async ({ where }: any) => claims.find((c) => c.id === where.id) || null,
    },
  };
  return { svc: new ClaimsService(prisma), claims, tasks };
}

const OPEN = [{ id: 't1', status: 'open', title: 'Send the vendor list' }];

describe('claim — records, never completes (BEA-1024)', () => {
  it('records who said it and their exact words, and leaves the task OPEN', async () => {
    const { svc, claims, tasks } = make(OPEN);
    await svc.claim({ taskId: 't1', contactId: 'c1', quote: 'sent it to the CA yesterday' });
    expect(claims[0]).toMatchObject({ taskId: 't1', contactId: 'c1', quote: 'sent it to the CA yesterday', status: 'pending', source: 'whatsapp' });
    expect(tasks[0].status).toBe('open'); // the whole point
  });

  it('does not stack duplicates — saying it twice updates the words', async () => {
    const { svc, claims } = make(OPEN);
    await svc.claim({ taskId: 't1', contactId: 'c1', quote: 'done' });
    await svc.claim({ taskId: 't1', contactId: 'c1', quote: 'done, sent it this morning' });
    expect(claims).toHaveLength(1);
    expect(claims[0].quote).toBe('done, sent it this morning');
  });

  it('ignores a claim on work that is already finished', async () => {
    const { svc, claims } = make([{ id: 't1', status: 'done', title: 'x' }]);
    expect(await svc.claim({ taskId: 't1', quote: 'done' })).toBeNull();
    expect(claims).toHaveLength(0);
  });

  it('ignores a claim on a task that does not exist', async () => {
    const { svc, claims } = make(OPEN);
    expect(await svc.claim({ taskId: 'nope', quote: 'done' })).toBeNull();
    expect(claims).toHaveLength(0);
  });

  it('never accepts an unknown source', async () => {
    const { svc, claims } = make(OPEN);
    await svc.claim({ taskId: 't1', quote: 'done', source: 'carrier-pigeon' });
    expect(claims[0].source).toBe('whatsapp');
  });

  it('keeps something readable when the message is empty', async () => {
    const { svc, claims } = make(OPEN);
    await svc.claim({ taskId: 't1', quote: '   ' });
    expect(claims[0].quote).toBe('(no message)');
  });
});

describe('pending / isPending — what keeps the chase quiet (BEA-1024)', () => {
  it('reports a task as waiting once claimed, and not before', async () => {
    const { svc } = make(OPEN);
    expect(await svc.isPending('t1')).toBe(false);
    await svc.claim({ taskId: 't1', quote: 'done' });
    expect(await svc.isPending('t1')).toBe(true);
  });

  it('withdrawing a claim clears it', async () => {
    const { svc, claims } = make(OPEN);
    await svc.claim({ taskId: 't1', quote: 'done' });
    expect(await svc.withdraw('t1')).toEqual({ ok: true });
    expect(claims).toHaveLength(0);
    expect(await svc.isPending('t1')).toBe(false);
  });

  it('withdrawing when nothing is claimed is harmless', async () => {
    const { svc } = make(OPEN);
    expect(await svc.withdraw('t1')).toEqual({ ok: false });
  });

  it('pendingFor returns nothing for an empty list without hitting the database', async () => {
    const { svc } = make(OPEN);
    expect((await svc.pendingFor([])).size).toBe(0);
  });
});
