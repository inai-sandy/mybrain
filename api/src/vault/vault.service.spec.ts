import { VaultService } from './vault.service';

// Stub MemoryService — label indexing is fire-and-forget and must never affect vault behaviour. (BEA-368)
const memory: any = { indexVaultItem: async () => undefined, deleteDoc: async () => undefined };

// Minimal in-memory Prisma stand-in for the two vault tables.
function makePrisma() {
  const metas: any[] = [];
  const items: any[] = [];
  let seq = 0;
  const id = () => `id-${++seq}`;
  return {
    _items: items,
    vaultMeta: {
      findFirst: async () => metas[0] || null,
      create: async ({ data }: any) => {
        const row = { id: id(), createdAt: new Date(), updatedAt: new Date(), ...data };
        metas.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = metas.find((m) => m.id === where.id);
        Object.assign(row, data);
        return row;
      },
    },
    vaultItem: {
      create: async ({ data }: any) => {
        const row = { id: id(), createdAt: new Date(), updatedAt: new Date(), favorite: false, ...data };
        items.push(row);
        return row;
      },
      findUnique: async ({ where }: any) => items.find((i) => i.id === where.id) || null,
      findMany: async ({ where, orderBy, skip = 0, take = 25 }: any) => {
        let r = items.filter((i) => match(i, where));
        if (orderBy?.title) r = [...r].sort((a, b) => String(a.title).localeCompare(String(b.title)));
        return r.slice(skip, skip + take);
      },
      count: async ({ where }: any = {}) => items.filter((i) => match(i, where)).length,
      update: async ({ where, data }: any) => {
        const row = items.find((i) => i.id === where.id);
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: any) => {
        const idx = items.findIndex((i) => i.id === where.id);
        items.splice(idx, 1);
        return {};
      },
    },
    vaultAudit: {
      create: async () => ({}),
      findMany: async () => [],
      deleteMany: async () => ({ count: 0 }),
    },
  } as any;
}

function match(item: any, where: any): boolean {
  if (!where) return true;
  if (where.type && item.type !== where.type) return false;
  if (where.collection && item.collection !== where.collection) return false;
  if (typeof where.favorite === 'boolean' && item.favorite !== where.favorite) return false;
  if (where.OR) {
    return where.OR.some((cond: any) => {
      const col = Object.keys(cond)[0];
      const needle = cond[col].contains;
      return typeof item[col] === 'string' && item[col].includes(needle);
    });
  }
  return true;
}

const cipher = (tag: string) => ({ iv: `iv-${tag}`, ct: `ct-${tag}` });
const blob = () => ({ v: 1, item: cipher('item'), dataKey: cipher('dk') });

describe('VaultService', () => {
  it('setup stores only ciphertext + can only run once', async () => {
    const prisma = makePrisma();
    const svc = new VaultService(prisma, memory);
    expect((await svc.getMeta()).setup).toBe(false);

    await svc.createMeta({ kdfParams: { type: 'argon2id' }, salt: 'c2FsdA==', verifier: cipher('v'), wrapPass: cipher('p'), wrapRecovery: cipher('r') });
    const meta = await svc.getMeta();
    expect(meta.setup).toBe(true);
    expect(meta.wrapRecovery).toEqual(cipher('r'));

    await expect(
      svc.createMeta({ kdfParams: {}, salt: 'x', verifier: cipher('v'), wrapPass: cipher('p'), wrapRecovery: cipher('r') }),
    ).rejects.toThrow(/already set up/);
  });

  it('rejects setup missing a wrapped key', async () => {
    const svc = new VaultService(makePrisma(), memory);
    await expect(svc.createMeta({ kdfParams: {}, salt: 'x', verifier: cipher('v'), wrapPass: undefined as any, wrapRecovery: cipher('r') })).rejects.toThrow();
  });

  it('rejects an item whose blob is not a client EncryptedBlob', async () => {
    const svc = new VaultService(makePrisma(), memory);
    await expect(svc.createItem({ type: 'login', blob: { password: 'plaintext!' } as any })).rejects.toThrow(/EncryptedBlob/);
    await expect(svc.createItem({ type: 'login', blob: 'nope' as any })).rejects.toThrow();
  });

  it('rejects an unknown item type', async () => {
    const svc = new VaultService(makePrisma(), memory);
    await expect(svc.createItem({ type: 'evil', blob: blob() })).rejects.toThrow(/type/);
  });

  it('stores searchable metadata and the ciphertext blob, never a plaintext secret column', async () => {
    const prisma = makePrisma();
    const svc = new VaultService(prisma, memory);
    const created = await svc.createItem({ type: 'login', blob: blob(), title: 'Gmail', website: 'mail.google.com', username: 'sandy' });
    const raw = prisma._items[0];
    expect(typeof raw.blob).toBe('string'); // stored as JSON string ciphertext
    expect(raw.title).toBe('Gmail');
    expect(Object.keys(raw)).not.toContain('password');
    expect(created.blob).toEqual(blob());
  });

  it('search matches metadata only', async () => {
    const svc = new VaultService(makePrisma(), memory);
    await svc.createItem({ type: 'login', blob: blob(), title: 'Gmail', username: 'sandy' });
    await svc.createItem({ type: 'login', blob: blob(), title: 'GitHub', username: 'octocat' });
    expect((await svc.listItems({ search: 'sandy' })).total).toBe(1);
    expect((await svc.listItems({ search: 'GitHub' })).items[0].title).toBe('GitHub');
    expect((await svc.listItems({ search: 'nothere' })).total).toBe(0);
  });

  it('deletes one item by id (no bulk delete)', async () => {
    const svc = new VaultService(makePrisma(), memory);
    const a = await svc.createItem({ type: 'note', blob: blob(), title: 'A' });
    await svc.createItem({ type: 'note', blob: blob(), title: 'B' });
    await svc.deleteItem(a.id);
    expect((await svc.count()).count).toBe(1);
    await expect(svc.deleteItem('missing')).rejects.toThrow(/not found/);
  });
});
