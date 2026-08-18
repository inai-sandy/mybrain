import { AgentFlowSyncService } from './agent-flow-sync.service';
import { FlowsService } from './flows.service';
import { AgentService } from '../agent/agent.service';
import { KEEP_AS_FETCHED } from '../social/social-flow';

/**
 * BEA-1366 — every agent shows its flow, automatically.
 *  • a Social agent's picture is rebuilt on a settings save (sources, output, WhatsApp, mode…), not on a rename;
 *  • a normal agent is planned ONCE on create (and again only when its task changes);
 *  • when the planner fails, the last picture is KEPT and the flow says so.
 */

/** An in-memory `prisma.flow` + `prisma.agent` good enough for FlowsService / AgentService. */
function memPrisma() {
  const flows = new Map<string, any>();
  const agents = new Map<string, any>();
  let n = 0;
  const now = () => new Date();
  const flowApi = {
    findMany: async ({ where }: any = {}) => [...flows.values()].filter((f) => !where?.agentId || f.agentId === where.agentId).sort((a, b) => b.updatedAt - a.updatedAt),
    findUnique: async ({ where }: any) => flows.get(where.id) || null,
    create: async ({ data }: any) => { const f = { id: `f${++n}`, name: 'Untitled flow', question: null, agentId: null, graph: '{"nodes":[],"edges":[]}', schedule: null, locked: false, drawnBy: null, drawStatus: null, drawNote: null, createdAt: now(), updatedAt: now(), ...data }; flows.set(f.id, f); return f; },
    update: async ({ where, data }: any) => { const f = flows.get(where.id); if (!f) throw new Error('nf'); Object.assign(f, data, { updatedAt: new Date(f.updatedAt.getTime() + 1) }); return f; },
  };
  const agentApi = {
    findMany: async () => [...agents.values()],
    findUnique: async ({ where }: any) => agents.get(where.id) || null,
    create: async ({ data }: any) => { const a = { id: `a${++n}`, areaId: 'area1', tools: '[]', evals: '[]', ...data }; agents.set(a.id, a); return a; },
    update: async ({ where, data }: any) => { const a = agents.get(where.id); if (!a) throw new Error('nf'); Object.assign(a, data); return a; },
  };
  (flowApi as any).updateMany = async ({ where, data }: any) => { let count = 0; for (const f of flows.values()) if (f.drawStatus === where.drawStatus) { Object.assign(f, data); count++; } return { count }; };
  return { flow: flowApi, agent: agentApi, toolCall: { findFirst: async () => null }, _flows: flows, _agents: agents };
}

const social = {
  name: 'IG digest', prompt: KEEP_AS_FETCHED, origin: 'social', category: 'Social',
  tools: ['svc:instagram.search_hashtag'], toolArgs: { 'svc:instagram.search_hashtag': { hashtag: 'smarthome' } },
  outputDest: 'sheet', notifyWhatsApp: false, mode: 'run',
};

function harness(planReply: string | null = GOOD_PLAN) {
  const prisma: any = memPrisma();
  const planCalls: string[] = [];
  const llm: any = { completeHelper: async (_k: string, p: string) => { planCalls.push(p); return planReply; } };
  const skills: any = { list: async () => [] };
  const prompts: any = { get: async () => 'PLAN {{question}} {{tools}} {{skills}}' };
  const catalog: any = { catalog: async () => ({ groups: [], tools: [
    { id: 'web_search', name: 'Web search', group: 'Web', description: 'search', connected: true, kind: 'tool' },
    { id: 'svc:instagram.search_hashtag', name: 'Instagram: Search hashtag', group: 'Social', description: 'x', connected: true, kind: 'tool', service: 'instagram' },
  ] }) };
  const agentSvc = new AgentService(prisma);
  const flows = new FlowsService(prisma, skills, llm, prompts, catalog, agentSvc);
  const sync = new AgentFlowSyncService(prisma, flows, agentSvc, catalog);
  agentSvc.setFlowSync(sync); // what onModuleInit does
  return { prisma, flows, sync, agentSvc, planCalls };
}
const GOOD_PLAN = JSON.stringify({ branches: [{ subquestion: 'What shipped?', steps: [{ kind: 'tool', id: 'web_search' }] }] });
const settle = () => new Promise((r) => setTimeout(r, 20));
const nodeIds = (f: any) => JSON.parse(f.graph).nodes.map((n: any) => n.id);

describe('AgentFlowSyncService — Social agents (BEA-1366)', () => {
  it('draws the picture on create, locked and machine-marked, without any model call', async () => {
    const { prisma, agentSvc, planCalls } = harness();
    const a: any = await agentSvc.createAgent(social as any);
    const f = [...prisma._flows.values()].find((x) => x.agentId === a.id);
    expect(f).toBeTruthy();
    expect(f.locked).toBe(true);
    expect(f.drawnBy).toBe('social');
    expect(f.name).toBe('IG digest — how it runs');
    expect(nodeIds(f)).toEqual(['question', 'src:svc:instagram.search_hashtag', 'write', 'end']);
    expect(planCalls).toHaveLength(0);
  });

  it('rebuilds when a source is added, the output changes or WhatsApp is switched on — and not on a rename', async () => {
    const { prisma, agentSvc } = harness();
    const a: any = await agentSvc.createAgent(social as any);
    const flowOf = () => [...prisma._flows.values()].find((x) => x.agentId === a.id);
    const before = flowOf().updatedAt;

    await agentSvc.updateAgent(a.id, { name: 'IG digest (renamed)' } as any);
    // a rename IS a picture change (the question node carries the name) — but a pure pause is not
    await agentSvc.updateAgent(a.id, { enabled: false } as any);
    const afterPause = flowOf();
    expect(nodeIds(afterPause)).toEqual(['question', 'src:svc:instagram.search_hashtag', 'write', 'end']);

    await agentSvc.updateAgent(a.id, { tools: ['svc:instagram.search_hashtag', 'svc:instagram.reels_search'], toolArgs: { 'svc:instagram.search_hashtag': { hashtag: 'smarthome' }, 'svc:instagram.reels_search': { query: 'smart home' } } } as any);
    expect(nodeIds(flowOf())).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.reels_search', 'merge', 'write', 'end']);

    await agentSvc.updateAgent(a.id, { notifyWhatsApp: true, prompt: 'Columns: creator, link' } as any);
    expect(nodeIds(flowOf())).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.reels_search', 'merge', 'shape', 'write', 'notify', 'end']);

    await agentSvc.updateAgent(a.id, { mode: 'watch' } as any);
    expect(nodeIds(flowOf())).toEqual(['question', 'src:svc:instagram.search_hashtag', 'src:svc:instagram.reels_search', 'merge', 'watch', 'write', 'notify', 'end']);
    expect(flowOf().updatedAt.getTime()).toBeGreaterThan(before.getTime());
    // still exactly one flow for the agent — rebuilt in place, never a second one
    expect([...prisma._flows.values()].filter((x) => x.agentId === a.id)).toHaveLength(1);
  });

  it('a hand-drawn locked flow is not overwritten from settings either', async () => {
    const { prisma, agentSvc } = harness();
    agentSvc.setFlowSync(null);
    const a: any = await agentSvc.createAgent(social as any);
    const hand = await prisma.flow.create({ data: { agentId: a.id, name: 'Hand', locked: true, graph: '{"nodes":[{"id":"x","data":{"kind":"tool"}}],"edges":[]}' } });
    const { sync } = harness();
    (sync as any).flows = new FlowsService(prisma, { list: async () => [] } as any, {} as any);
    (sync as any).prisma = prisma;
    expect(await sync.drawSocial(await agentSvc.getAgent(a.id))).toBeNull();
    expect(prisma._flows.get(hand.id).graph).toContain('"id":"x"');
  });

  it('back-fill draws every Social agent once and is idempotent', async () => {
    const { prisma, agentSvc, sync } = harness();
    // a legacy Social agent saved before this existed → no flow yet
    agentSvc.setFlowSync(null);
    const a: any = await agentSvc.createAgent(social as any);
    const normal: any = await agentSvc.createAgent({ name: 'Normal', prompt: 'do things' } as any);
    expect(prisma._flows.size).toBe(0);
    expect(await sync.backfillSocial()).toBe(1);
    expect([...prisma._flows.values()].map((f) => f.agentId)).toEqual([a.id]);
    // the normal agent is NOT planned at boot (that costs a model call per agent)
    expect([...prisma._flows.values()].find((f) => f.agentId === normal.id)).toBeUndefined();
    expect(await sync.backfillSocial()).toBe(0); // nothing changed → nothing rewritten
  });
});

describe('AgentFlowSyncService — every other agent (BEA-1366)', () => {
  it('create makes the flow at once (drawing…) and calls the planner exactly once', async () => {
    const { prisma, agentSvc, planCalls } = harness();
    const a: any = await agentSvc.createAgent({ name: 'Research', prompt: 'Find the best EV chargers for apartments' } as any);
    const f = () => [...prisma._flows.values()].find((x) => x.agentId === a.id);
    expect(f()).toBeTruthy(); // exists straight after the save
    expect(f().question).toBe('Find the best EV chargers for apartments');
    await settle();
    expect(planCalls).toHaveLength(1);
    expect(f().drawStatus).toBeNull();
    expect(f().drawnBy).toBe('planner');
    expect(nodeIds(f())).toContain('b0_s0');
    // a save that does not touch the task does not re-plan
    await agentSvc.updateAgent(a.id, { name: 'Research (renamed)', notifyWhatsApp: true } as any);
    await settle();
    expect(planCalls).toHaveLength(1);
    // a task change does
    await agentSvc.updateAgent(a.id, { prompt: 'Find the best EV chargers for Indian apartments' } as any);
    await settle();
    expect(planCalls).toHaveLength(2);
    expect(f().question).toBe('Find the best EV chargers for Indian apartments');
  });

  it('a restart mid-plan: flows left "drawing" become "failed — try again" at boot', async () => {
    const { prisma, sync } = harness();
    await prisma.flow.create({ data: { agentId: 'zz', name: 'stuck', drawStatus: 'drawing' } });
    await prisma.flow.create({ data: { agentId: 'yy', name: 'fine', drawStatus: null } });
    expect(await sync.reconcileStuckDrawing()).toBe(1);
    const rows = [...prisma._flows.values()];
    expect(rows.find((f) => f.name === 'stuck').drawStatus).toBe('failed');
    expect(rows.find((f) => f.name === 'stuck').drawNote).toBe(FlowsService.REDRAW_FAILED_NOTE);
    expect(rows.find((f) => f.name === 'fine').drawStatus).toBeNull();
  });

  it('an agent with no task yet is not planned', async () => {
    const { prisma, agentSvc, planCalls } = harness();
    await agentSvc.createAgent({ name: 'Empty' } as any);
    await settle();
    expect(prisma._flows.size).toBe(0);
    expect(planCalls).toHaveLength(0);
  });

  it('planner failure keeps the last picture and says so; a later success clears the note', async () => {
    const { prisma, flows, agentSvc, planCalls } = harness();
    const a: any = await agentSvc.createAgent({ name: 'Research', prompt: 'Find X' } as any);
    await settle();
    const f = () => [...prisma._flows.values()].find((x) => x.agentId === a.id);
    const good = f().graph;
    expect(nodeIds(f())).toContain('b0_s0');
    // now the planner answers rubbish
    (flows as any).llm.completeHelper = async () => 'I cannot help with that.';
    await agentSvc.updateAgent(a.id, { prompt: 'Find Y' } as any);
    await settle();
    expect(f().graph).toBe(good); // the picture is KEPT
    expect(f().drawStatus).toBe('failed');
    expect(f().drawNote).toBe(FlowsService.REDRAW_FAILED_NOTE);
    // and when the planner throws outright
    (flows as any).llm.completeHelper = async () => { throw new Error('engine down'); };
    await agentSvc.updateAgent(a.id, { prompt: 'Find Z' } as any);
    await settle();
    expect(f().graph).toBe(good);
    expect(f().drawStatus).toBe('failed');
    // a working planner clears it
    (flows as any).llm.completeHelper = async () => GOOD_PLAN;
    await agentSvc.updateAgent(a.id, { prompt: 'Find W' } as any);
    await settle();
    expect(f().drawStatus).toBeNull();
    expect(f().drawNote).toBeNull();
    expect(planCalls).toHaveLength(1); // the swapped-in planners above did not go through the counting stub
  });

  it('a first draw that fails still leaves a (marked) picture — never a blank canvas', async () => {
    const { prisma, agentSvc } = harness(null);
    const a: any = await agentSvc.createAgent({ name: 'Research', prompt: 'Find X' } as any);
    await settle();
    const f = [...prisma._flows.values()].find((x) => x.agentId === a.id);
    expect(JSON.parse(f.graph).nodes.length).toBeGreaterThan(0);
    expect(f.drawStatus).toBe('failed');
  });

  it('a hand-drawn locked flow (AI News Daily) is never re-planned by a task save', async () => {
    const { prisma, agentSvc, planCalls } = harness();
    agentSvc.setFlowSync(null);
    const a: any = await agentSvc.createAgent({ name: 'AI News Daily', prompt: 'collect the news' } as any);
    const hand = await prisma.flow.create({ data: { agentId: a.id, name: 'AI News Daily — noon', locked: true, graph: '{"nodes":[{"id":"x","data":{"kind":"tool"}}],"edges":[]}' } });
    const { sync } = harness(); void sync;
    // re-attach a sync bound to THIS prisma
    const flowsSvc = new FlowsService(prisma, { list: async () => [] } as any, { completeHelper: async (_k: string, p: string) => { planCalls.push(p); return GOOD_PLAN; } } as any, { get: async () => 'P {{question}}' } as any, undefined, agentSvc);
    agentSvc.setFlowSync(new AgentFlowSyncService(prisma, flowsSvc, agentSvc));
    await agentSvc.updateAgent(a.id, { prompt: 'collect the news, then write it' } as any);
    await settle();
    expect(planCalls).toHaveLength(0);
    expect(prisma._flows.get(hand.id).graph).toContain('"id":"x"');
  });

  it('createAgent({ drawFlow:false }) draws nothing — the caller owns the picture (voice research)', async () => {
    const { prisma, agentSvc, planCalls } = harness();
    await agentSvc.createAgent({ name: 'Voice', prompt: 'research this' } as any, { drawFlow: false });
    await settle();
    expect(prisma._flows.size).toBe(0);
    expect(planCalls).toHaveLength(0);
  });
});
