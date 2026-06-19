import { ConnectionsService } from './connections.service';

function makePrisma(connections: any[]) {
  return {
    item: { findMany: async () => [{ id: 'doc1', title: 'Pricing research', summary: 'vendor pricing comparison' }] },
    idea: { findMany: async () => [] },
    task: { findMany: async () => [] },
    meeting: { findMany: async () => [] },
    connection: {
      findMany: async ({ select }: any) => (select ? connections.map((c) => ({ anchorKey: c.anchorKey })) : connections),
      create: async ({ data }: any) => {
        connections.push({ id: String(connections.length + 1), ...data });
        return connections[connections.length - 1];
      },
      update: async () => ({}),
      updateMany: async () => ({}),
    },
  } as any;
}

describe('ConnectionsService.discover', () => {
  const memory: any = {
    searchBrain: jest.fn(async () => [
      { memId: 'sm-t1', score: 0.82, title: 'Send pricing to Diksha' },
      { memId: 'sm-m1', score: 0.71, title: 'Pricing sync meeting' },
    ]),
    resolveRefs: jest.fn(async () => ({ 'sm-t1': { type: 'task', id: 't1' }, 'sm-m1': { type: 'meeting', id: 'm1' } })),
  };

  it('creates a cross-type connection, then de-dups by anchor on re-run', async () => {
    const store: any[] = [];
    const r1 = await new ConnectionsService(makePrisma(store), memory).discover();
    expect(r1.found).toBe(1);
    expect(store).toHaveLength(1);
    expect(store[0].anchorKey).toBe('item:doc1');
    expect(store[0].summary).toContain('Pricing research');
    const items = JSON.parse(store[0].items);
    expect(items.length).toBe(3); // anchor + 2 related
    expect(items[0]).toMatchObject({ type: 'item', link: '/doc/doc1' });

    const r2 = await new ConnectionsService(makePrisma(store), memory).discover();
    expect(r2.found).toBe(0); // anchor already connected
  });

  it('skips when there is no cross-type cluster', async () => {
    const sameType: any = {
      searchBrain: jest.fn(async () => [{ memId: 'x', score: 0.9, title: 'Another doc' }]),
      resolveRefs: jest.fn(async () => ({ x: { type: 'item', id: 'doc2' } })),
    };
    const store: any[] = [];
    const r = await new ConnectionsService(makePrisma(store), sameType).discover();
    expect(r.found).toBe(0); // only a same-type match → no connection
  });
});
