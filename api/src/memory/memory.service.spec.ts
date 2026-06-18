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
    taskUpdates: [] as any[],
    task: {
      update: async ({ where, data }: any) => {
        (prisma.taskUpdates as any[]).push({ id: where.id, data });
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

  it('writes the store ids back to the RIGHT table for a non-item refType (task)', async () => {
    const prisma = fakePrisma();
    const sm: any = { save: jest.fn(async () => 'sm-t'), delete: jest.fn(async () => undefined) };
    const rag: any = { save: jest.fn(async () => 'rag-t'), delete: jest.fn(async () => undefined) };
    const svc = new MemoryService(prisma, sm, rag);

    await svc.indexEntity({ refType: 'task', refId: 'task-1', content: 'do the thing', title: 'Task: do the thing' });
    await svc.drain();

    // Linked onto the task table, NOT the item table (the old bug indexed but never linked tasks).
    expect(prisma.taskUpdates.some((u: any) => u.id === 'task-1' && u.data.supermemoryId === 'sm-t')).toBe(true);
    expect(prisma.taskUpdates.some((u: any) => u.id === 'task-1' && u.data.ragId === 'rag-t')).toBe(true);
    expect(prisma.itemUpdates).toHaveLength(0);
  });

  it('indexEntity deletes the previous docs first so a re-index replaces (no dupes)', async () => {
    const prisma = fakePrisma();
    const sm: any = { save: jest.fn(async () => 'sm-new'), delete: jest.fn(async () => undefined) };
    const rag: any = { save: jest.fn(async () => 'rag-new'), delete: jest.fn(async () => undefined) };
    const svc = new MemoryService(prisma, sm, rag);

    await svc.indexEntity({
      refType: 'task',
      refId: 'task-1',
      content: 'edited',
      prevSupermemoryId: 'sm-old',
      prevRagId: 'rag-old',
    });

    expect(sm.delete).toHaveBeenCalledWith('sm-old');
    expect(rag.delete).toHaveBeenCalledWith('rag-old');
  });
});

describe('MemoryService.searchScoped (strict scoping)', () => {
  function svcWith(smResults: any[], ragResults: any[]) {
    const sm: any = { search: jest.fn(async () => smResults) };
    const rag: any = { search: jest.fn(async () => ragResults) };
    return { svc: new MemoryService(fakePrisma(), sm, rag), sm, rag };
  }

  it('keeps only include-tagged results and never widens the scope', async () => {
    // SuperMemory returns a mix; only the activity-tagged one should survive an Activity scope.
    const sm = [
      { content: 'day summary', metadata: { tags: 'activity' } },
      { content: 'a bookmark', metadata: { tags: 'bookmark' } },
    ];
    const { svc } = svcWith(sm, []);
    const hits = await svc.searchScoped('what happened', ['activity'], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('day summary');
  });

  it('falls back to RAG but STILL enforces the scope (no whole-brain leak)', async () => {
    // SuperMemory empty → RAG fallback; RAG returns mixed tags, only activity kept.
    const rag = [
      { content: 'unrelated bookmark', tags: ['bookmark'] },
      { content: 'the 8th day summary', tags: ['activity'] },
    ];
    const { svc } = svcWith([], rag);
    const hits = await svc.searchScoped('most important activity', ['activity'], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('day summary');
  });

  it('Capture scope excludes the special buckets', async () => {
    const rag = [
      { content: 'a saved document', tags: ['research'] },
      { content: 'an activity summary', tags: ['activity'] },
      { content: 'a bookmark', tags: ['bookmark'] },
    ];
    const { svc } = svcWith([], rag);
    const hits = await svc.searchScoped('the report', [], 5, ['bookmark', 'idea', 'activity', 'skill']);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('saved document');
  });
});
