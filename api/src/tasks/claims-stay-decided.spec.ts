import { ClaimsService } from './claims.service';

/**
 * BEA-1186 — the owner clears "Needs you" and the same items come back a few refreshes later.
 * The chase agent re-reads the contact's LATEST inbound on every pass, so a message he has already
 * ruled on was being re-claimed. A decision has to stick to the message, not just to the row.
 */
function build(claims: any[]) {
  const created: any[] = [];
  const prisma: any = {
    task: { findUnique: async () => ({ id: 't1', status: 'open', title: 'Send the report', kind: 'assignment' }) },
    taskClaim: {
      findFirst: async ({ where }: any) => claims.find((c) => c.taskId === where.taskId && c.status === where.status) || null,
      findMany: async ({ where }: any) => claims.filter((c) => c.taskId === where.taskId && where.status.in.includes(c.status)),
      create: async ({ data }: any) => { const row = { id: 'new', status: 'pending', ...data }; created.push(row); claims.push(row); return row; },
      update: async ({ where, data }: any) => { const c = claims.find((x) => x.id === where.id); Object.assign(c, data); return c; },
    },
  };
  return { svc: new ClaimsService(prisma, {} as any), created };
}

const MSG = 'yes it is done';

describe('a decided claim stays decided (BEA-1186)', () => {
  it('does NOT come back after the owner rejected it', async () => {
    const { svc, created } = build([{ id: 'c1', taskId: 't1', contactId: 'p1', quote: MSG, status: 'rejected' }]);
    const out = await svc.claim({ taskId: 't1', contactId: 'p1', quote: MSG, source: 'whatsapp' });
    expect(out).toBeNull();
    expect(created.length).toBe(0);
  });

  it('does NOT come back after the owner confirmed it', async () => {
    const { svc, created } = build([{ id: 'c1', taskId: 't1', contactId: 'p1', quote: MSG, status: 'confirmed' }]);
    expect(await svc.claim({ taskId: 't1', contactId: 'p1', quote: MSG, source: 'whatsapp' })).toBeNull();
    expect(created.length).toBe(0);
  });

  it('ignores casing and spacing — the agent re-quotes the same words loosely', async () => {
    const { svc, created } = build([{ id: 'c1', taskId: 't1', contactId: 'p1', quote: MSG, status: 'rejected' }]);
    await svc.claim({ taskId: 't1', contactId: 'p1', quote: '  Yes It Is   DONE ', source: 'whatsapp' });
    expect(created.length).toBe(0);
  });

  it('DOES create one when they send genuinely new words', async () => {
    const { svc, created } = build([{ id: 'c1', taskId: 't1', contactId: 'p1', quote: MSG, status: 'rejected' }]);
    const out = await svc.claim({ taskId: 't1', contactId: 'p1', quote: 'finished it this morning, sending now', source: 'whatsapp' });
    expect(out).not.toBeNull();
    expect(created.length).toBe(1);
  });

  it('DOES create one when a different person says it', async () => {
    const { svc, created } = build([{ id: 'c1', taskId: 't1', contactId: 'p1', quote: MSG, status: 'rejected' }]);
    await svc.claim({ taskId: 't1', contactId: 'p2', quote: MSG, source: 'whatsapp' });
    expect(created.length).toBe(1);
  });

  it('still updates a claim that is waiting rather than stacking a second row', async () => {
    const claims = [{ id: 'c1', taskId: 't1', contactId: 'p1', quote: 'almost there', status: 'pending' }];
    const { svc, created } = build(claims);
    await svc.claim({ taskId: 't1', contactId: 'p1', quote: 'ok it is done now', source: 'whatsapp' });
    expect(created.length).toBe(0);
    expect(claims[0].quote).toBe('ok it is done now');
  });
});
