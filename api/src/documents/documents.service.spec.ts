import { DocumentsService } from './documents.service';

// Minimal in-memory fake of the Prisma `document` model.
function fakePrisma() {
  const rows: any[] = [];
  return {
    _rows: rows,
    document: {
      create: async ({ data }: any) => {
        const row = { id: 'id-' + (rows.length + 1), createdAt: new Date(), updatedAt: new Date(), shared: false, ...data };
        rows.push(row);
        return row;
      },
      findMany: async () => [...rows].reverse(),
      findUnique: async ({ where }: any) => rows.find((r) => (where.id ? r.id === where.id : r.slug === where.slug)) || null,
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
      delete: async ({ where }: any) => {
        const i = rows.findIndex((x) => x.id === where.id);
        if (i < 0) throw new Error('not found');
        return rows.splice(i, 1)[0];
      },
    },
  };
}

describe('DocumentsService', () => {
  it('creates a markdown doc with a slug, tags, and an auto description', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any);
    const doc = await svc.create({ title: 'My Research Notes', contentText: '# Heading\n\nSome **important** body text here.', tags: ['research', 'notes'] });
    expect(doc.title).toBe('My Research Notes');
    expect(doc.slug).toMatch(/^my-research-notes-[a-z0-9]{6}$/);
    expect(doc.tags).toEqual(['research', 'notes']);
    expect(doc.description).toContain('important');
    expect(doc.description).not.toContain('#');
    expect(doc.contentText).toContain('Heading');
  });

  it('lists newest-first without content, gets full content, updates, and deletes', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any);
    const a = await svc.create({ title: 'First', contentText: 'a' });
    await svc.create({ title: 'Second', contentText: 'b' });
    const listed = await svc.list();
    expect(listed.documents).toHaveLength(2);
    expect(listed.documents[0].title).toBe('Second'); // newest first
    expect((listed.documents[0] as any).contentText).toBeUndefined(); // list payload is light

    const updated = await svc.update(a.id, { title: 'First Edited', contentText: 'aa', tags: ['x'] });
    expect(updated?.title).toBe('First Edited');
    expect(updated?.contentText).toBe('aa');
    expect(updated?.tags).toEqual(['x']);

    await svc.remove(a.id);
    expect((await svc.list()).documents).toHaveLength(1);
  });

  it('shares a doc and only returns it publicly once shared', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any);
    const doc = await svc.create({ title: 'Shareable', contentText: 'hello world' });
    expect(await svc.getShared(doc.slug)).toBeNull(); // not shared yet

    await svc.setShared(doc.id, true);
    const pub = await svc.getShared(doc.slug);
    expect(pub?.title).toBe('Shareable');
    expect(pub?.contentText).toBe('hello world');

    await svc.setShared(doc.id, false);
    expect(await svc.getShared(doc.slug)).toBeNull();
  });

  it('produces a download payload with a safe filename', async () => {
    const prisma = fakePrisma();
    const svc = new DocumentsService(prisma as any);
    const doc = await svc.create({ title: 'Hello / World!', contentText: '# Hi' });
    const raw = await svc.raw(doc.id);
    expect(raw?.filename).toBe('hello-world.md');
    expect(raw?.content).toBe('# Hi');
  });
});
