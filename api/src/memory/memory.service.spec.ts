import { MemoryService } from './memory.service';

function fakePrisma() {
  const rows: any[] = [];
  const prisma: any = {
    rows,
    memoryOutbox: {
      createMany: async ({ data }: any) => {
        data.forEach((d: any) => rows.push({ id: String(rows.length + 1), status: 'pending', attempts: 0, ...d }));
        return { count: data.length };
      },
      findMany: async () => rows.filter((r) => r.status === 'pending' && r.attempts < 3),
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      },
      groupBy: async () => [],
    },
    itemUpdates: [] as any[],
    item: {
      update: async ({ where, data }: any) => {
        (prisma.itemUpdates as any[]).push({ id: where.id, data });
        return {};
      },
    },
  };
  return prisma as any;
}

describe('MemoryService outbox', () => {
  it('enqueues two targets and drains both on success', async () => {
    const prisma = fakePrisma();
    const sm: any = { save: jest.fn(async () => 'sm1') };
    const rag: any = { save: jest.fn(async () => 'rag1') };
    const svc = new MemoryService(prisma, sm, rag);

    await svc.enqueue('hello', { tags: ['t'] });
    expect(prisma.rows.length).toBe(2);

    const { processed } = await svc.drain();
    expect(processed).toBe(2);
    expect(prisma.rows.every((r: any) => r.status === 'done')).toBe(true);
    expect(sm.save).toHaveBeenCalled();
    expect(rag.save).toHaveBeenCalled();
  });

  it('retries the failing store, keeps the other consistent', async () => {
    const prisma = fakePrisma();
    const sm: any = { save: jest.fn(async () => { throw new Error('boom'); }) };
    const rag: any = { save: jest.fn(async () => 'rag1') };
    const svc = new MemoryService(prisma, sm, rag);

    await svc.enqueue('hello');
    await svc.drain();

    const smRow = prisma.rows.find((r: any) => r.target === 'supermemory');
    const ragRow = prisma.rows.find((r: any) => r.target === 'rag');
    expect(ragRow.status).toBe('done'); // the good store committed
    expect(smRow.status).toBe('pending'); // the bad one is retryable, not lost
    expect(smRow.attempts).toBe(1);
  });

  it('records the returned store ids onto the item', async () => {
    const prisma = fakePrisma();
    const sm: any = { save: jest.fn(async () => 'sm-id-1') };
    const rag: any = { save: jest.fn(async () => 'rag-id-1') };
    const svc = new MemoryService(prisma, sm, rag);

    await svc.enqueue('hi', { itemId: 'item-1' });
    await svc.drain();

    expect(prisma.itemUpdates.some((u: any) => u.data.supermemoryId === 'sm-id-1')).toBe(true);
    expect(prisma.itemUpdates.some((u: any) => u.data.ragId === 'rag-id-1')).toBe(true);
  });
});
