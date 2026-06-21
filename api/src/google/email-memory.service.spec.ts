import { EmailMemoryService } from './email-memory.service';

function make(opts: { body?: string; metas?: any[]; enabled?: boolean; connected?: boolean } = {}) {
  const rows: Record<string, any> = {};
  const prisma: any = {
    _rows: rows,
    emailMemory: {
      findUnique: async ({ where }: any) => rows[where.id] || null,
      upsert: async ({ where, create, update }: any) => {
        rows[where.id] = rows[where.id] ? { ...rows[where.id], ...update } : { ...create };
        return rows[where.id];
      },
      count: async () => Object.keys(rows).length,
    },
  };
  const google: any = {
    gmailMessageFull: jest.fn(async () => opts.body ?? 'FULL BODY TEXT'),
    gmailImportantForDay: jest.fn(async () => opts.metas ?? []),
    status: jest.fn(async () => ({ connected: opts.connected ?? true })),
  };
  const memory: any = {
    sourceEnabled: jest.fn(() => opts.enabled ?? true),
    indexEmail: jest.fn(async () => undefined),
  };
  return { svc: new EmailMemoryService(prisma, google, memory), prisma, google, memory };
}

const meta = (id: string) => ({ id, threadId: `t-${id}`, from: 'vendor@acme.com', subject: 'June invoice', date: 'Sat, 20 Jun 2026 10:00:00 +0530', snippet: 'snippet' });

describe('EmailMemoryService (BEA-439)', () => {
  it('stores the FULL body and indexes the email into memory', async () => {
    const { svc, prisma, google, memory } = make({ body: 'Dear Sandeep, the June invoice is attached. Total ₹42,000.' });
    const ok = await svc.syncOne('2026-06-20', meta('m1'));
    expect(ok).toBe(true);
    expect(google.gmailMessageFull).toHaveBeenCalledWith('m1');
    expect(prisma._rows['m1'].body).toContain('June invoice is attached');
    expect(prisma._rows['m1'].subject).toBe('June invoice');
    expect(memory.indexEmail).toHaveBeenCalledWith(prisma._rows['m1']);
  });

  it('upserts by message id — re-syncing the same email does not duplicate', async () => {
    const { svc, prisma } = make({ body: 'v2 body' });
    await svc.syncOne('2026-06-20', meta('m1'));
    await svc.syncOne('2026-06-20', meta('m1'));
    expect(Object.keys(prisma._rows)).toEqual(['m1']);
  });

  it('does nothing when the Important Emails source is turned off', async () => {
    const { svc, google, memory } = make({ enabled: false });
    expect(await svc.syncOne('d', meta('m1'))).toBe(false);
    expect(google.gmailMessageFull).not.toHaveBeenCalled();
    expect(memory.indexEmail).not.toHaveBeenCalled();
  });

  it('syncDay indexes every important email of the day', async () => {
    const { svc } = make({ metas: [meta('a'), meta('b'), meta('c')] });
    expect(await svc.syncDay('2026-06-20')).toBe(3);
  });

  it('maybeBackfill is skipped once the store already has emails', async () => {
    const { svc, prisma, google } = make({ metas: [meta('a')] });
    prisma._rows['seed'] = { id: 'seed' }; // already populated
    await (svc as any).maybeBackfill();
    expect(google.gmailImportantForDay).not.toHaveBeenCalled();
  });
});
