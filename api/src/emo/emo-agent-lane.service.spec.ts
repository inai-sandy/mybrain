import { EmoAgentLaneService } from './emo-agent-lane.service';

describe('EmoAgentLane — run agents by voice (BEA-1086)', () => {
  const AGENTS = [
    { id: 'a1', name: 'Morning Brief', enabled: true, prompt: 'brief me', defaultDepth: 'quick', collectionId: null, rubric: null, skills: [] },
    { id: 'a2', name: 'Bookmark Triage', enabled: true, prompt: 'triage', defaultDepth: 'standard', collectionId: null, rubric: null, skills: [] },
    { id: 'a3', name: 'Old Brief', enabled: false, prompt: 'x', skills: [] },
  ];

  function harness(card: any) {
    const updates: any[] = [];
    const cards: any = { get: jest.fn(async () => card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); }) };
    const agent: any = { listAgents: jest.fn(async () => AGENTS) };
    const bridge: any = { applyAgentSkills: jest.fn(async (_a: any, i: any) => i), startRun: jest.fn(async (i: any) => ({ id: 'run-9', ...i })) };
    return { svc: new EmoAgentLaneService(cards, agent, bridge), updates, bridge };
  }

  it('"run my morning brief" starts exactly that agent with the spoken words attached', async () => {
    const h = harness({ id: 'c1', lane: 'agent', rawTranscript: 'run my morning brief please' });
    await h.svc.handle('c1');
    expect(h.bridge.startRun).toHaveBeenCalledTimes(1);
    const input = h.bridge.startRun.mock.calls[0][0];
    expect(input.agentId).toBe('a1');
    expect(input.prompt).toContain('[Spoken request] run my morning brief');
    expect(updatesDone(h.updates)).toContain('▶ Started Morning Brief');
  });

  it('an ambiguous ask never guesses — it asks which agent', async () => {
    const h = harness({ id: 'c1', lane: 'agent', rawTranscript: 'run the brief' }); // matches nothing fully
    await h.svc.handle('c1');
    expect(h.bridge.startRun).not.toHaveBeenCalled();
    expect(h.updates[0].status).toBe('needs_you');
    expect(h.updates[0].needsQuestion).toContain('Which agent');
  });

  it('the answer to "which one?" completes the run', async () => {
    const h = harness({ id: 'c1', lane: 'agent', rawTranscript: 'run the thing' });
    await h.svc.handle('c1', 'bookmark triage');
    expect(h.bridge.startRun).toHaveBeenCalledTimes(1);
    expect(h.bridge.startRun.mock.calls[0][0].agentId).toBe('a2');
  });

  function updatesDone(updates: any[]): string {
    return updates.map((u) => u.summary || '').join(' ');
  }
});

/** BEA-1107: "run my daily news" may name the AGENT (area) — resolve to its job, never guessing. */
describe('area-aware voice resolution (BEA-1107)', () => {
  const jobs = [
    { id: 'j1', name: 'Tech news', areaId: 'ar1', enabled: true, prompt: 'get tech news' },
    { id: 'j2', name: 'Crypto brief', areaId: 'ar2', enabled: true, prompt: 'get crypto' },
    { id: 'j3', name: 'Morning digest', areaId: 'ar2', enabled: true, prompt: 'digest' },
  ];
  const build = (updates: any[]) => {
    const cards: any = { get: jest.fn(async () => ({ id: 'c1', lane: 'agent', rawTranscript: '' })), update: jest.fn(async (_id: string, p: any) => { updates.push(p); }) };
    const agent: any = { listAgents: jest.fn(async () => jobs) };
    const bridge: any = { applyAgentSkills: jest.fn(async (_a: any, i: any) => i), startRun: jest.fn(async () => ({ id: 'run1' })) };
    const areas: any = { list: jest.fn(async () => [{ id: 'ar1', name: 'Daily News' }, { id: 'ar2', name: 'Money Agent' }]) };
    const { EmoAgentLaneService } = require('./emo-agent-lane.service');
    return new (EmoAgentLaneService as any)(cards, agent, bridge, areas);
  };

  it('a one-job area name runs that job', async () => {
    const updates: any[] = [];
    const svc = build(updates);
    (svc as any).cards.get = jest.fn(async () => ({ id: 'c1', lane: 'agent', rawTranscript: 'run my daily news' }));
    await svc.handle('c1');
    expect(updates.at(-1).status).toBe('done');
    expect(updates.at(-1).summary).toContain('Tech news'); // resolved to the area's single job
  });

  it('a multi-job area name asks which job — never guesses', async () => {
    const updates: any[] = [];
    const svc = build(updates);
    (svc as any).cards.get = jest.fn(async () => ({ id: 'c1', lane: 'agent', rawTranscript: 'run my money agent' }));
    await svc.handle('c1');
    expect(updates.at(-1).status).toBe('needs_you');
    expect(updates.at(-1).needsQuestion).toContain('Which job of Money Agent');
    expect(updates.at(-1).needsQuestion).toContain('Crypto brief');
  });
});
