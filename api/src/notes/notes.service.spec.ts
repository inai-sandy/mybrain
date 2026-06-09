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
  return { svc: new NotesService(prisma), rows };
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
