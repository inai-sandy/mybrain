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
  // The recurring ledger the claim guard writes to instead of creating a review item.
  const days: any[] = [];
  const recurring: any = {
    today: () => '2026-07-27',
    markReceived: async (taskId: string, day: string, quote?: string | null, contactId?: string | null) => {
      const i = days.findIndex((d) => d.taskId === taskId && d.day === day);
      const row = { taskId, day, status: 'received', quote: quote || null, contactId: contactId || null };
      if (i >= 0) days[i] = row; else days.push(row);
    },
  };
  return { svc: new ClaimsService(prisma, recurring), claims, tasks, days };
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


/**
 * BEA-1118: a recurring daily report can NEVER be claimed. Confirming one done would stop its
 * chase forever and tomorrow's update would never be asked for — the exact failure the owner was
 * working around by rejecting Jayanth's ticks by hand every day.
 */
const DAILY = [{ id: 't9', status: 'open', title: 'Send the daily production update', kind: 'recurring' }];

describe('a daily report can never be claimed (BEA-1118)', () => {
  it('creates NO review item — nothing for the owner to confirm or reject', async () => {
    const { svc, claims } = make(DAILY);
    const row = await svc.claim({ taskId: 't9', contactId: 'c1', quote: "Ticked it off on their page" });
    expect(row).toBeNull();
    expect(claims).toHaveLength(0);
  });

  it('records it against TODAY instead, keeping their words', async () => {
    const { svc, days } = make(DAILY);
    await svc.claim({ taskId: 't9', contactId: 'c1', quote: 'OT 8 members, 2 on fitting' });
    expect(days).toEqual([{ taskId: 't9', day: '2026-07-27', status: 'received', quote: 'OT 8 members, 2 on fitting', contactId: 'c1' }]);
  });

  it('leaves the task open, so the chase returns tomorrow', async () => {
    const { svc, tasks } = make(DAILY);
    await svc.claim({ taskId: 't9', quote: 'done' });
    expect(tasks[0].status).toBe('open');
  });

  it('still claims normally for an assignment — the other kind is untouched', async () => {
    const { svc, claims, days } = make([{ id: 't1', status: 'open', title: 'Upload the BOMs', kind: 'assignment' }]);
    const row = await svc.claim({ taskId: 't1', contactId: 'c1', quote: 'uploaded' });
    expect(row).not.toBeNull();
    expect(claims).toHaveLength(1);
    expect(days).toHaveLength(0);
  });

  it('treats a task with no kind set as an assignment (nothing existing changes)', async () => {
    const { svc, claims } = make([{ id: 't1', status: 'open', title: 'Old task with no kind' }]);
    expect(await svc.claim({ taskId: 't1', quote: 'done' })).not.toBeNull();
    expect(claims).toHaveLength(1);
  });
});
