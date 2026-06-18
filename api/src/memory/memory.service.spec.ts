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

describe('MemoryService.reconcile (BEA-333 safety net)', () => {
  function makeReconcilePrisma(seed: Record<string, any[]>) {
    const outbox: any[] = [];
    const tableFor = (name: string) => (seed[name] = seed[name] || []);
    const filtered = (name: string, where: any) => {
      let rows = tableFor(name);
      if (where?.OR) rows = rows.filter((r: any) => r.ragId == null || r.supermemoryId == null);
      return rows;
    };
    const prisma: any = {
      memoryOutbox: {
        createMany: async ({ data }: any) => {
          data.forEach((d: any) => outbox.push({ id: String(outbox.length + 1), status: 'pending', attempts: 0, ...d }));
          return { count: data.length };
        },
        findMany: async () => outbox.filter((r) => r.status === 'pending' && r.attempts < 3),
        update: async ({ where, data }: any) => {
          Object.assign(outbox.find((x) => x.id === where.id), data);
          return {};
        },
        updateMany: async ({ where, data }: any) => {
          let n = 0;
          outbox.forEach((r) => {
            if (r.status === where.status) {
              Object.assign(r, data);
              n++;
            }
          });
          return { count: n };
        },
        groupBy: async () => [],
      },
      _outbox: outbox,
    };
    for (const t of ['item', 'idea', 'meeting', 'task', 'story', 'note', 'gmailBrief', 'gmailRequest']) {
      prisma[t] = {
        findMany: async ({ where, take }: any = {}) => {
          const rows = filtered(t, where);
          return take ? rows.slice(0, take) : rows;
        },
        count: async ({ where }: any = {}) => filtered(t, where).length,
        update: async ({ where, data }: any) => {
          const r = tableFor(t).find((x: any) => x.id === where.id);
          if (r) Object.assign(r, data);
          return r || {};
        },
      };
    }
    return prisma;
  }

  it('re-enqueues a both-null meeting and links it on drain', async () => {
    const seed: any = { meeting: [{ id: 'm1', title: 'Sync', summary: 'we decided X', ragId: null, supermemoryId: null }] };
    const prisma = makeReconcilePrisma(seed);
    const sm: any = { save: jest.fn(async () => 'sm-m'), getContent: jest.fn(), delete: jest.fn() };
    const rag: any = { save: jest.fn(async () => 'rag-m'), delete: jest.fn() };
    const svc = new MemoryService(prisma, sm, rag);

    const res = await svc.reconcile();
    await svc.drain();

    expect(res.reEnqueued).toBe(1);
    expect(sm.save).toHaveBeenCalled();
    expect(rag.save).toHaveBeenCalled();
    expect(seed.meeting[0].supermemoryId).toBe('sm-m');
    expect(seed.meeting[0].ragId).toBe('rag-m');
  });

  it('fills ONLY the missing RAG side by copying content from SuperMemory (no SM dup)', async () => {
    const seed: any = { item: [{ id: 'i1', title: 'Doc', summary: 's', ragId: null, supermemoryId: 'sm-existing' }] };
    const prisma = makeReconcilePrisma(seed);
    const sm: any = {
      save: jest.fn(async () => 'sm-NEW'),
      getContent: jest.fn(async () => ({ content: 'full doc body', title: 'Doc', summary: '', tags: ['research'] })),
      delete: jest.fn(),
    };
    const rag: any = { save: jest.fn(async () => 'rag-i'), delete: jest.fn() };
    const svc = new MemoryService(prisma, sm, rag);

    await svc.reconcile();
    await svc.drain();

    expect(sm.getContent).toHaveBeenCalledWith('sm-existing');
    expect(rag.save).toHaveBeenCalled(); // added to RAG
    expect(sm.save).not.toHaveBeenCalled(); // SM untouched — no duplicate
    expect(seed.item[0].ragId).toBe('rag-i');
    expect(seed.item[0].supermemoryId).toBe('sm-existing'); // unchanged
  });

  it('revives failed outbox rows', async () => {
    const seed: any = {};
    const prisma = makeReconcilePrisma(seed);
    prisma._outbox.push({ id: '99', status: 'failed', attempts: 3, target: 'rag', payload: '{}' });
    const svc = new MemoryService(prisma, { save: jest.fn() } as any, { save: jest.fn() } as any);

    const res = await svc.reconcile();
    expect(res.retried).toBe(1);
    expect(prisma._outbox[0].status).toBe('pending');
  });
});

describe('MemoryService retrieval (BEA-332 whole-brain merge/re-rank/fallback)', () => {
  function svcWith(smResults: any[], ragResults: any[]) {
    const sm: any = { search: jest.fn(async () => smResults) };
    const rag: any = { search: jest.fn(async () => ragResults) };
    return { svc: new MemoryService(fakePrisma(), sm, rag), sm, rag };
  }

  it('returns the higher-scoring RAG hit over a lower SM hit (no SuperMemory-first short-circuit)', async () => {
    const sm = [{ id: 's1', content: 'weak supermemory hit', score: 0.3 }];
    const rag = [{ id: 'r1', content: 'strong rag hit', score: 0.9 }];
    const { svc, sm: smMock, rag: ragMock } = svcWith(sm, rag);
    const hits = await svc.searchBrain('q', 5);
    expect(smMock.search).toHaveBeenCalled();
    expect(ragMock.search).toHaveBeenCalled(); // BOTH queried, in parallel
    expect(hits[0].content).toBe('strong rag hit');
    expect(hits[0].source).toBe('rag');
  });

  it('de-dups the same doc living in both stores (dual-write twins), keeping the higher score', async () => {
    const sm = [{ id: 's1', title: 'Doc', content: 'identical body of the document', score: 0.6 }];
    const rag = [{ id: 'r1', title: 'Doc', content: 'identical body of the document', score: 0.85 }];
    const { svc } = svcWith(sm, rag);
    const hits = await svc.searchBrain('q', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBe(0.85);
  });

  it('boosts recent + spine (activity/task) content in the ranking', async () => {
    const old = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 1 * 86_400_000).toISOString();
    // Lower raw score but recent + activity should outrank a slightly higher, old, untagged hit.
    const sm = [{ id: 's1', content: 'old generic note', score: 0.7, createdAt: old, metadata: { tags: '' } }];
    const rag = [{ id: 'r1', content: 'todays story', score: 0.62, createdAt: recent, tags: ['activity', 'story'] }];
    const { svc } = svcWith(sm, rag);
    const hits = await svc.searchBrain('q', 5);
    expect(hits[0].content).toBe('todays story');
  });

  it('whole-brain fallback: a scoped query that finds nothing in-scope widens instead of returning empty', async () => {
    // Only a bookmark exists; an Activity-scoped search finds nothing in scope → should fall back to whole brain.
    const sm = [{ id: 's1', content: 'a useful bookmark', score: 0.8, metadata: { tags: 'bookmark' } }];
    const { svc } = svcWith(sm, []);
    const hits = await svc.searchScoped('q', ['activity'], 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain('bookmark');
  });
});

describe('MemoryService index-source gate (BEA-335)', () => {
  it('does NOT index a disabled section', async () => {
    const prisma = fakePrisma();
    const svc = new MemoryService(prisma, { save: jest.fn() } as any, { save: jest.fn() } as any);
    (svc as any).enabled.set('note', false);
    await svc.indexEntity({ refType: 'note', refId: 'n1', content: 'a private note' });
    expect(prisma.rows.length).toBe(0); // gated — nothing enqueued
  });

  it('DOES index an enabled section', async () => {
    const prisma = fakePrisma();
    const svc = new MemoryService(prisma, { save: jest.fn() } as any, { save: jest.fn() } as any);
    (svc as any).enabled.set('task', true);
    await svc.indexEntity({ refType: 'task', refId: 't1', content: 'a task' });
    expect(prisma.rows.length).toBe(2); // both stores enqueued
  });

  it('defaults Notes off and everything else on', async () => {
    const svc = new MemoryService(fakePrisma(), {} as any, {} as any);
    expect(svc.sourceEnabled('task')).toBe(true);
    expect(svc.sourceEnabled('story')).toBe(true);
    expect(svc.sourceEnabled('note')).toBe(false);
  });
});
