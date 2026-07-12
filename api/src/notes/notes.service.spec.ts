import { NotesService } from './notes.service';

function make() {
  const rows: any[] = [];
  let seq = 0;
  const prisma: any = {
    note: {
      findMany: async ({ where }: any = {}) =>
        rows
          .filter((r) => (where?.archived === undefined ? true : r.archived === where.archived))
          .sort((a, b) => (a.pinned === b.pinned ? new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() : a.pinned ? -1 : 1)),
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
      create: async ({ data }: any) => {
        const row = { id: `n${++seq}`, createdAt: new Date(), updatedAt: new Date(), pinned: false, archived: false, color: 'default', ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id);
        Object.assign(r, data, { updatedAt: new Date(Date.now() + 1) });
        return r;
      },
      delete: async ({ where }: any) => {
        const i = rows.findIndex((x) => x.id === where.id);
        if (i >= 0) rows.splice(i, 1);
        return {};
      },
    },
  };
  const memory: any = { indexEntity: async () => undefined, deleteDoc: async () => undefined };
  return { svc: new NotesService(prisma, memory, { complete: async () => "x" } as any), rows };
}

describe('NotesService', () => {
  it('creates a text note and cleans tags + color', async () => {
    const { svc } = make();
    const n = await svc.create({ title: 'Shopping', content: 'milk, eggs', color: 'teal', tags: ['Food', 'food', 'HOME'] });
    expect(n!.title).toBe('Shopping');
    expect(n!.color).toBe('teal');
    expect(n!.tags).toEqual(['food', 'home']); // lowercased + deduped
  });

  it('falls back to default color for an unknown color', async () => {
    const { svc } = make();
    const n = await svc.create({ content: 'hi', color: 'chartreuse' });
    expect(n!.color).toBe('default');
  });

  it('creates a checklist note and drops empty items', async () => {
    const { svc } = make();
    const n = await svc.create({ checklist: [{ text: 'buy milk', done: false }, { text: '', done: false }, { text: 'call mom', done: true }] });
    expect(n!.checklist).toHaveLength(2);
    expect(n!.checklist[1]).toEqual({ text: 'call mom', done: true });
  });

  it('rejects a completely empty note', async () => {
    const { svc } = make();
    expect(await svc.create({ title: '  ', content: '' })).toBeNull();
  });

  it('lists pinned first and returns color/tag facets', async () => {
    const { svc } = make();
    await svc.create({ content: 'a', color: 'red', tags: ['x'] });
    const b = await svc.create({ content: 'b', color: 'blue', tags: ['y'] });
    await svc.update(b!.id, { pinned: true });
    const res = await svc.list(false);
    expect(res.notes[0].id).toBe(b!.id); // pinned first
    expect(res.colors).toEqual(expect.arrayContaining(['red', 'blue']));
    expect(res.tags).toEqual(expect.arrayContaining(['x', 'y']));
  });

  it('archives via update and hides from the active list', async () => {
    const { svc } = make();
    const n = await svc.create({ content: 'temp' });
    await svc.update(n!.id, { archived: true });
    expect((await svc.list(false)).count).toBe(0);
    expect((await svc.list(true)).count).toBe(1);
  });
});

describe('NotesService.aiFormat (BEA-964)', () => {
  it('formats the note into markdown, saves it, and returns the previous content for undo', async () => {
    const note = { id: 'n1', title: 'T', content: 'messy raw note', checklist: '[]', supermemoryId: null, ragId: null };
    let saved: any = null;
    const prisma: any = {
      note: {
        findUnique: async () => note,
        update: async ({ data }: any) => { saved = data; return { ...note, ...data, updatedAt: new Date(), createdAt: new Date(), color: 'default', tags: '[]' }; },
      },
    };
    const svc = new NotesService(prisma, { indexEntity: async () => undefined } as any, { complete: async () => '## Clean\n- point one\n- point two' } as any);
    const r = await svc.aiFormat('n1');
    expect(r.ok).toBe(true);
    expect(saved.content).toBe('## Clean\n- point one\n- point two'); // saved the formatted markdown
    expect(r.previous).toBe('messy raw note'); // original returned for undo
    expect(r.note.content).toBe('## Clean\n- point one\n- point two');
  });

  it('is a no-op when there is nothing to format', async () => {
    const prisma: any = { note: { findUnique: async () => ({ id: 'n2', content: '', checklist: '[]' }) } };
    const svc = new NotesService(prisma, {} as any, {} as any);
    expect(await svc.aiFormat('n2')).toEqual({ ok: false });
  });
});
