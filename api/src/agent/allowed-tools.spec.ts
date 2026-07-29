import { AgentService } from './agent.service';

/**
 * BEA-1168 — the toolbox has to MEAN something. These lock the resolution rules and the one
 * behaviour that matters: a tool nobody ticked is never offered to a run.
 */
function svc(agent: any, area: any) {
  const prisma: any = {
    agent: { findUnique: async ({ where }: any) => (where.id === agent?.id ? agent : null) },
    agentArea: { findUnique: async ({ where }: any) => (where.id === area?.id ? area : null) },
  };
  return new AgentService(prisma as any);
}

describe('allowedTools (BEA-1168)', () => {
  const area = { id: 'ar1', tools: JSON.stringify([{ id: 'search_brain', name: 'Search my brain' }, { id: 'gmail', name: 'Gmail' }]) };

  it("uses the job's own set when it has one", async () => {
    const a = { id: 'j1', areaId: 'ar1', tools: JSON.stringify(['web_search']) };
    expect(await svc(a, area).allowedTools('j1')).toEqual({ ids: ['web_search'], source: 'job' });
  });

  it("falls back to the agent's toolbox when the job has none", async () => {
    const a = { id: 'j1', areaId: 'ar1', tools: '[]' };
    expect(await svc(a, area).allowedTools('j1')).toEqual({ ids: ['search_brain', 'gmail'], source: 'agent' });
  });

  it('reports "none" when nobody has picked anything anywhere', async () => {
    const a = { id: 'j1', areaId: 'ar1', tools: '[]' };
    const empty = { id: 'ar1', tools: '[]' };
    expect(await svc(a, empty).allowedTools('j1')).toEqual({ ids: [], source: 'none' });
  });

  it('ignores hand-typed toolbox entries that carry no catalog id', async () => {
    const a = { id: 'j1', areaId: 'ar1', tools: '[]' };
    const mixed = { id: 'ar1', tools: JSON.stringify([{ id: 'gmail', name: 'Gmail' }, { name: 'some CLI', kind: 'cli' }]) };
    expect((await svc(a, mixed).allowedTools('j1')).ids).toEqual(['gmail']);
  });

  it('never throws on broken JSON or a missing agent', async () => {
    const a = { id: 'j1', areaId: 'ar1', tools: 'not json' };
    expect((await svc(a, { id: 'ar1', tools: '{{{' }).allowedTools('j1')).ids).toEqual([]);
    expect(await svc(a, area).allowedTools('nope')).toEqual({ ids: [], source: 'none' });
    expect(await svc(a, area).allowedTools(null)).toEqual({ ids: [], source: 'none' });
  });
});

/**
 * BEA-1168 — a job whose picked tool has since lost its credentials must STOP and name it, rather
 * than run half-blind. This exercises the bridge's toolbox() resolution directly.
 */
describe('a picked tool that is no longer connected (BEA-1168)', () => {
  const { HermesBridgeService } = require('../hermes/hermes-bridge.service');
  const agent = (ids: string[]) => ({ allowedTools: async () => ({ ids, source: 'job' }) });
  const catalog = (rows: any[]) => ({ catalog: async () => ({ groups: [], tools: rows }) });

  const build = (ids: string[], rows: any[]) =>
    new HermesBridgeService(agent(ids), {}, {}, {}, {}, {}, undefined, undefined, undefined, catalog(rows));

  it('reports the disconnected tool by name', async () => {
    const svc: any = build(['gmail', 'web_search'], [
      { id: 'gmail', name: 'Gmail', description: 'email', connected: false },
      { id: 'web_search', name: 'Web search', description: 'web', connected: true },
    ]);
    const box = await svc.toolbox('j1');
    expect(box.disconnected.map((t: any) => t.name)).toEqual(['Gmail']);
  });

  it('reports nothing disconnected when everything is connected', async () => {
    const svc: any = build(['web_search'], [{ id: 'web_search', name: 'Web search', description: 'web', connected: true }]);
    const box = await svc.toolbox('j1');
    expect(box.disconnected).toEqual([]);
    expect(box.guidance).toContain('ONLY things you may use');
    expect(box.guidance).toContain('Web search');
  });

  it('lists only the picked tools — an unpicked one is never offered to the engine', async () => {
    const svc: any = build(['web_search'], [
      { id: 'web_search', name: 'Web search', description: 'web', connected: true },
      { id: 'gmail', name: 'Gmail', description: 'email', connected: true },
    ]);
    const box = await svc.toolbox('j1');
    expect(box.guidance).toContain('Web search');
    expect(box.guidance).not.toContain('Gmail');
  });

  it('does not block the run when the catalog itself is unreachable', async () => {
    const svc: any = new HermesBridgeService(agent(['gmail']), {}, {}, {}, {}, {}, undefined, undefined, undefined, { catalog: async () => { throw new Error('down'); } });
    const box = await svc.toolbox('j1');
    expect(box.disconnected).toEqual([]);
    expect(box.guidance).toContain('gmail');
  });
});
