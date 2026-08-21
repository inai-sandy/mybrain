import { AgentAreasService } from './agent-areas.service';
import { AgentService } from './agent.service';

/**
 * BEA-1380 — flat folders for the Agents home. The owner creates folders and moves his agent cards
 * (AgentArea rows) into them; All + Unfiled are views. These lock the rules that matter:
 *   • CRUD + counts, duplicate names refused
 *   • move (single + bulk) — and a move to a folder that is gone fails plainly
 *   • deleting a folder NEVER deletes agents — they return to Unfiled
 *   • an agent created from inside a folder lands in that folder (wrapper area included)
 */

function db(seed: { folders?: any[]; areas?: any[] } = {}) {
  const folders: any[] = (seed.folders || []).map((f) => ({ order: 0, createdAt: new Date(), ...f }));
  const areas: any[] = (seed.areas || []).map((a) => ({ folderId: null, tools: '[]', ...a }));
  const agents: any[] = [];
  let n = 0;
  const matches = (row: any, where: any = {}): boolean => {
    for (const [k, v] of Object.entries(where)) {
      if (v && typeof v === 'object' && Array.isArray((v as any).in)) { if (!(v as any).in.includes(row[k])) return false; }
      else if (row[k] !== v) return false;
    }
    return true;
  };
  const table = (rows: any[], prefix: string) => ({
    findMany: async ({ where }: any = {}) => rows.filter((r) => matches(r, where || {})),
    findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
    create: async ({ data }: any) => { const row = { id: prefix + ++n, createdAt: new Date(), ...data }; rows.push(row); return row; },
    update: async ({ where, data }: any) => { const r = rows.find((x) => x.id === where.id); if (!r) throw new Error('not found'); Object.assign(r, data); return r; },
    updateMany: async ({ where, data }: any) => { let count = 0; for (const r of rows) if (matches(r, where || {})) { Object.assign(r, data); count++; } return { count }; },
    delete: async ({ where }: any) => { const i = rows.findIndex((x) => x.id === where.id); if (i < 0) throw new Error('not found'); return rows.splice(i, 1)[0]; },
    deleteMany: async () => ({ count: 0 }),
    count: async ({ where }: any = {}) => rows.filter((r) => matches(r, where || {})).length,
  });
  const prisma: any = {
    agentFolder: table(folders, 'f'),
    agentArea: table(areas, 'a'),
    agent: table(agents, 'j'),
    agentRun: { findMany: async () => [] },
  };
  return { prisma, folders, areas, agents };
}

describe('folders CRUD + counts (BEA-1380)', () => {
  it('creates folders in order and lists them with per-folder, All and Unfiled counts', async () => {
    const { prisma } = db({ areas: [{ id: 'a1', name: 'Radar' }, { id: 'a2', name: 'Sheets' }, { id: 'a3', name: 'News' }] });
    const svc = new AgentAreasService(prisma);
    const work = await svc.createFolder('Work');
    await svc.createFolder('Play');
    await svc.update('a1', { folderId: work.id });
    await svc.update('a2', { folderId: work.id });
    const out = await svc.listFolders();
    expect(out.folders.map((f: any) => f.name)).toEqual(['Work', 'Play']);
    expect(out.folders[0].count).toBe(2);
    expect(out.folders[1].count).toBe(0);
    expect(out.all).toBe(3);
    expect(out.unfiled).toBe(1);
  });

  it('refuses an empty name and a duplicate name (case-insensitive), on create and rename', async () => {
    const { prisma } = db();
    const svc = new AgentAreasService(prisma);
    await expect(svc.createFolder('   ')).rejects.toThrow(/name/i);
    await svc.createFolder('Work');
    await expect(svc.createFolder('work')).rejects.toThrow(/already/i);
    const other = await svc.createFolder('Play');
    await expect(svc.updateFolder(other.id, { name: 'WORK' })).rejects.toThrow(/already/i);
    const renamed = await svc.updateFolder(other.id, { name: 'Weekend' });
    expect(renamed.name).toBe('Weekend');
  });
});

describe('moving agent cards between folders (BEA-1380)', () => {
  it('moves one card in, and back to Unfiled with folderId null', async () => {
    const { prisma, areas } = db({ folders: [{ id: 'f1', name: 'Work' }], areas: [{ id: 'a1', name: 'Radar' }] });
    const svc = new AgentAreasService(prisma);
    await svc.update('a1', { folderId: 'f1' });
    expect(areas.find((a) => a.id === 'a1').folderId).toBe('f1');
    await svc.update('a1', { folderId: null });
    expect(areas.find((a) => a.id === 'a1').folderId).toBeNull();
  });

  it('refuses a move into a folder that no longer exists', async () => {
    const { prisma } = db({ areas: [{ id: 'a1', name: 'Radar' }] });
    const svc = new AgentAreasService(prisma);
    await expect(svc.update('a1', { folderId: 'gone' })).rejects.toThrow(/folder/i);
  });

  it('bulk-moves several cards in one call, and to Unfiled', async () => {
    const { prisma, areas } = db({ folders: [{ id: 'f1', name: 'Work' }], areas: [{ id: 'a1', name: 'Radar' }, { id: 'a2', name: 'Sheets' }, { id: 'a3', name: 'News' }] });
    const svc = new AgentAreasService(prisma);
    const res = await svc.moveAreasToFolder(['a1', 'a3'], 'f1');
    expect(res).toMatchObject({ ok: true, moved: 2, folderId: 'f1' });
    expect(areas.map((a) => a.folderId)).toEqual(['f1', null, 'f1']);
    const back = await svc.moveAreasToFolder(['a1'], null);
    expect(back.moved).toBe(1);
    expect(areas.find((a) => a.id === 'a1').folderId).toBeNull();
    await expect(svc.moveAreasToFolder([], 'f1')).rejects.toThrow(/at least one/i);
    await expect(svc.moveAreasToFolder(['a1'], 'gone')).rejects.toThrow(/folder/i);
  });
});

describe('deleting a folder un-files its agents — never deletes them (BEA-1380)', () => {
  it('sends the folder\'s cards back to Unfiled and keeps every agent row', async () => {
    const { prisma, folders, areas } = db({
      folders: [{ id: 'f1', name: 'Work' }],
      areas: [{ id: 'a1', name: 'Radar', folderId: 'f1' }, { id: 'a2', name: 'Sheets', folderId: 'f1' }, { id: 'a3', name: 'News' }],
    });
    const svc = new AgentAreasService(prisma);
    const res = await svc.deleteFolder('f1');
    expect(res).toMatchObject({ ok: true, unfiled: 2 });
    expect(folders.length).toBe(0);
    expect(areas.length).toBe(3); // nothing else is lost
    expect(areas.every((a) => a.folderId === null)).toBe(true);
  });

  it('refuses a folder that does not exist', async () => {
    const { prisma } = db();
    const svc = new AgentAreasService(prisma);
    await expect(svc.deleteFolder('nope')).rejects.toThrow(/not found/i);
  });
});

describe('created from inside a folder → lands in that folder (BEA-1380)', () => {
  it('an area created with folderId sits in the folder; a stale folder id degrades to Unfiled', async () => {
    const { prisma, areas } = db({ folders: [{ id: 'f1', name: 'Work' }] });
    const svc = new AgentAreasService(prisma);
    const made: any = await svc.create({ name: 'Radar', folderId: 'f1' });
    expect(areas.find((a) => a.id === made.id).folderId).toBe('f1');
    const stale: any = await svc.create({ name: 'Other', folderId: 'gone' });
    expect(areas.find((a) => a.id === stale.id).folderId).toBeNull();
  });

  it('createAgent puts the auto-created wrapper area into the folder too', async () => {
    const { prisma, areas } = db({ folders: [{ id: 'f1', name: 'Work' }] });
    const agentSvc = new AgentService(prisma);
    const made: any = await agentSvc.createAgent({ name: 'Morning Radar', folderId: 'f1' } as any, { drawFlow: false });
    const wrapper = areas.find((a) => a.id === made.areaId);
    expect(wrapper).toBeTruthy();
    expect(wrapper.folderId).toBe('f1');
  });

  it('createAgent with a stale folder id still creates — the card just lands in Unfiled', async () => {
    const { prisma, areas } = db();
    const agentSvc = new AgentService(prisma);
    const made: any = await agentSvc.createAgent({ name: 'Morning Radar', folderId: 'gone' } as any, { drawFlow: false });
    const wrapper = areas.find((a) => a.id === made.areaId);
    expect(wrapper).toBeTruthy();
    expect(wrapper.folderId ?? null).toBeNull();
  });
});
