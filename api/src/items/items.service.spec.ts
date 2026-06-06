import { ItemsService } from './items.service';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function fakeDeps() {
  const rows: any[] = [];
  const prisma: any = {
    item: {
      findUnique: async ({ where }: any) => {
        if (where.contentHash_source) {
          return (
            rows.find(
              (r) => r.contentHash === where.contentHash_source.contentHash && r.source === where.contentHash_source.source,
            ) || null
          );
        }
        return rows.find((r) => r.id === where.id) || null;
      },
      create: async ({ data }: any) => {
        const it = { id: String(rows.length + 1), createdAt: new Date(), filePath: null, ...data };
        rows.push(it);
        return it;
      },
      update: async ({ where, data }: any) => {
        const it = rows.find((r) => r.id === where.id);
        Object.assign(it, data);
        return it;
      },
      findMany: async () => [...rows].reverse(),
      delete: async ({ where }: any) => {
        const i = rows.findIndex((r) => r.id === where.id);
        if (i >= 0) rows.splice(i, 1);
      },
    },
  };
  const memory: any = { enqueue: jest.fn(async () => undefined) };
  return { svc: new ItemsService(prisma, memory), rows, memory };
}

describe('ItemsService', () => {
  beforeAll(() => {
    process.env.DATA_DIR = join(tmpdir(), 'mybrain-items-test');
  });
  afterAll(async () => {
    await fs.rm(process.env.DATA_DIR as string, { recursive: true, force: true }).catch(() => undefined);
  });

  it('stores once, enqueues dual-write, and dedups identical content', async () => {
    const { svc, memory } = fakeDeps();
    const a = await svc.store('# Hello\n\nworld', 'upload', 'hello');
    expect(a.deduped).toBe(false);
    expect(memory.enqueue).toHaveBeenCalledTimes(1);

    const b = await svc.store('# Hello\n\nworld', 'upload', 'hello');
    expect(b.deduped).toBe(true);
    expect(memory.enqueue).toHaveBeenCalledTimes(1); // not enqueued again
  });

  it('lists stored items with derived titles', async () => {
    const { svc } = fakeDeps();
    await svc.store('# My Note\n\nbody', 'upload', '');
    const list = await svc.list();
    expect(list.length).toBe(1);
    expect(list[0].title).toBe('My Note');
  });
});
