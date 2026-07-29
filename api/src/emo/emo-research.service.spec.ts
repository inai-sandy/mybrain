import { EmoResearchService } from './emo-research.service';
import { PromptsService } from '../prompts/prompts.service';

// Real registry defaults (no prisma overrides) so prompt-content routing in the LLM mock works.
const realPrompts = new PromptsService({ setting: { findUnique: async () => null, findMany: async () => [] } } as any);

function make(opts: { card: any; brief?: string; clarify?: string; result?: string }) {
  const updates: any[] = [];
  const cards: any = { get: jest.fn(async () => opts.card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return {}; }) };
  const llm: any = { complete: jest.fn(async (prompt: string) => (prompt.includes('research brief') ? (opts.brief ?? '{"topic":"CCTV market","question":"What is the CCTV market in India?"}') : (opts.clarify ?? '{"questions":["What angle?"],"options":["Overview","Competitors"]}'))) };
  const flows: any = { create: jest.fn(async () => ({ id: 'f1' })), planAndSave: jest.fn(async () => ({ id: 'f1' })) };
  const agent: any = { createRun: jest.fn(async () => ({ id: 'run1' })), getRun: jest.fn(async () => ({ resultText: opts.result ?? '## CCTV\n- finding [src]', status: 'done' })) };
  const bridge: any = { execute: jest.fn(async () => undefined) };
  // BEA-1175: voice research lands under the Research Agent, picks tools, and runs itself.
  const areas: any = { ensureResearchAgent: jest.fn(async () => ({ id: 'ar1' })) };
  const runner: any = { start: jest.fn(async () => ({ runId: 'fr1' })) };
  const catalog: any = { catalog: async () => ({ groups: [], tools: [
    { id: 'web_search', name: 'Web search', group: 'Web', description: 'web', connected: true, kind: 'tool' },
    { id: 'save_document', name: 'Save to Documents', group: 'Output', description: 'save', connected: true, kind: 'tool' },
  ] }) };
  agent.createAgent = jest.fn(async (i: any) => ({ id: 'job1', name: i.name }));
  agent.updateAgent = jest.fn(async () => ({}));
  flows.update = jest.fn(async () => ({}));
  return { svc: new EmoResearchService(llm, cards, flows, agent, bridge, realPrompts as any, areas, runner, catalog), cards, flows, agent, bridge, areas, runner, updates };
}

describe('EmoResearchService — Deep (BEA-870)', () => {
  const freshCard = { id: 'c1', lane: 'research', rawTranscript: 'research the cctv market', summary: 'Research: CCTV', status: 'cooking', needsAnswer: null };

  it('asks NOTHING — the Research Agent already knows how he likes research done (BEA-1175)', async () => {
    const { svc, updates } = make({ card: freshCard });
    await svc.handle('c1');
    expect(updates.some((u) => u.status === 'needs_you')).toBe(false);
    expect(updates.some((u) => u.needsQuestion)).toBe(false);
  });

  it('files the job under the Research Agent, marked as coming from voice', async () => {
    const { svc, areas, agent } = make({ card: freshCard });
    await svc.handle('c1');
    expect(areas.ensureResearchAgent).toHaveBeenCalled();
    const created = agent.createAgent.mock.calls[0][0];
    expect(created.areaId).toBe('ar1');
    expect(created.origin).toBe('voice');
    expect(created.defaultDepth).toBe('deep'); // full depth, as the owner chose
  });

  it('picks its own tools from the connected catalog', async () => {
    const { svc, agent } = make({ card: freshCard });
    await svc.handle('c1');
    const created = agent.createAgent.mock.calls[0][0];
    expect(Array.isArray(created.tools)).toBe(true);
    expect(created.tools.length).toBeGreaterThan(0);
    for (const t of created.tools) expect(['web_search', 'save_document']).toContain(t); // never an unconnected one
  });

  it('attaches the flow to the job and RUNS it — nothing to press', async () => {
    const { svc, flows, runner, updates } = make({ card: freshCard });
    await svc.handle('c1');
    expect(flows.create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'job1' }));
    expect(flows.planAndSave).toHaveBeenCalledWith('f1');
    expect(runner.start).toHaveBeenCalledWith('f1');
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.links.some((l: any) => l.kind === 'agent' && l.id === 'job1')).toBe(true);
  });

  it('never leaves the card stuck mid-flight when the flow cannot be built', async () => {
    // A card left on "cooking" is invisible-broken: nothing ever revisits it, so the owner waits
    // for a result that is never coming.
    const { svc, flows, updates } = make({ card: freshCard });
    flows.create.mockRejectedValueOnce(new Error('database is locked'));
    await svc.handle('c1');
    const last = updates[updates.length - 1];
    expect(last.status).toBe('done');
    expect(last.detail).toMatch(/press Run/i);
    expect(last.links.some((l: any) => l.kind === 'agent')).toBe(true); // the job is real, so link to it
  });

  it('says it made a Research Agent when there was not one', async () => {
    const { svc, areas, updates } = make({ card: freshCard });
    areas.ensureResearchAgent.mockResolvedValueOnce({ id: 'ar1', created: true });
    await svc.handle('c1');
    expect(updates[updates.length - 1].detail).toMatch(/set up a Research Agent/i);
  });

  it('says so plainly if it could not start, instead of pretending', async () => {
    const { svc, runner, updates } = make({ card: freshCard });
    runner.start.mockRejectedValueOnce(new Error('engine down'));
    await svc.handle('c1');
    const done = updates[updates.length - 1];
    expect(done.detail).toMatch(/could not start/i);
  });
});

describe('EmoResearchService — Quick (BEA-871)', () => {
  it('runs immediately (no clarify) when the word "quick" is present', async () => {
    const { svc, agent, bridge, flows, updates } = make({ card: { id: 'c1', lane: 'research', rawTranscript: 'quick research on NVR pricing', summary: 'Research: NVR', status: 'cooking', needsAnswer: null } });
    await svc.handle('c1');
    expect(flows.create).not.toHaveBeenCalled(); // no flow built for quick
    expect(agent.createRun).toHaveBeenCalled();
    expect(bridge.execute).toHaveBeenCalledWith('run1', expect.objectContaining({ depth: 'quick', save: false })); // fast tier, not the slow path (BEA-879)
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toMatch(/^Quick research:/);
    expect(done.detail).toContain('CCTV'); // the synthesised result
    expect(done.links[0]).toMatchObject({ kind: 'agent', id: 'run1' }); // no flow link → offers Go deeper
  });

  it('goDeeper turns a finished quick card into a saved deep flow', async () => {
    const { svc, flows, updates } = make({ card: { id: 'c1', lane: 'research', rawTranscript: 'quick research on NVR pricing', summary: 'Quick research: NVR', status: 'done', detail: 'the quick answer', links: [{ kind: 'agent', id: 'run1' }] } });
    await svc.goDeeper('c1');
    expect(flows.create).toHaveBeenCalled();
    const patch = updates[updates.length - 1];
    expect(patch.links.some((l: any) => l.kind === 'flow')).toBe(true);
    expect(patch.detail).toMatch(/Went deeper/);
  });

  it('goDeeper is a no-op if the card already has a deep flow', async () => {
    const { svc, flows } = make({ card: { id: 'c1', lane: 'research', status: 'done', links: [{ kind: 'flow', id: 'f0' }] } });
    await svc.goDeeper('c1');
    expect(flows.create).not.toHaveBeenCalled();
  });

  it('ignores a non-research card', async () => {
    const { svc, flows } = make({ card: { id: 'c1', lane: 'task' } });
    await svc.handle('c1');
    expect(flows.create).not.toHaveBeenCalled();
  });
});

/**
 * BEA-1184 — the owner's own notes are not searched as a side effect of asking for research.
 * "If required, I'll add it manually." These pin what must NOT happen.
 */
describe('brain tools are never picked on his behalf (BEA-1184)', () => {
  const card = (t: string) => ({ id: 'c1', lane: 'research', rawTranscript: t, summary: 'Research', status: 'cooking', needsAnswer: null });

  it('does not add Search my brain to an ordinary research request', async () => {
    const { svc, agent } = make({ card: card('research the cctv market in India') });
    await svc.handle('c1');
    const tools = agent.createAgent.mock.calls[0][0].tools || [];
    expect(tools).not.toContain('search_brain');
    expect(tools).not.toContain('search_rag');
    expect(tools).not.toContain('fetch_document');
  });

  it('still gives it real research tools', async () => {
    const { svc, agent } = make({ card: card('research the cctv market in India') });
    await svc.handle('c1');
    const tools = agent.createAgent.mock.calls[0][0].tools || [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools).toContain('web_search');
  });

  it('recognises when he DID ask for his own notes', () => {
    const w = (EmoResearchService as any).wantsBrain;
    expect(w('research this and check my notes on it')).toBe(true);
    expect(w('what did i write about the cctv market')).toBe(true);
    expect(w('look in my second brain for this')).toBe(true);
    expect(w('research the cctv market in India')).toBe(false);
    expect(w('research how brain implants work')).toBe(false); // "brain" alone is a topic, not his brain
  });
});

/**
 * BEA-1191 — two ways the voice path could quietly go wrong.
 */
describe('voice research failure modes (BEA-1191)', () => {
  const card = { id: 'c1', lane: 'research', rawTranscript: 'quick research the cctv market', summary: 'Research', status: 'cooking', needsAnswer: null };

  it('a quick research can never park — a card has no way to show a question', async () => {
    const { svc, bridge } = make({ card });
    await svc.handle('c1');
    expect(bridge.execute).toHaveBeenCalled();
    const opts = bridge.execute.mock.calls[0][1];
    expect(opts.allowAsk).toBe(false);
  });

  it('a tool-picker failure NARROWS the toolbox instead of widening it', async () => {
    const deep = { ...card, rawTranscript: 'research the cctv market' };
    const { svc, agent } = make({ card: deep });
    // the catalog is unreachable
    const svcAny: any = svc;
    svcAny.catalog = { catalog: async () => { throw new Error('engine down'); } };
    await svc.handle('c1');
    const tools = agent.createAgent.mock.calls[0][0].tools || [];
    expect(tools.length).toBeGreaterThan(0);          // it still gets a real, narrow set
    expect(tools).not.toContain('search_brain');      // and never the brain (BEA-1184)
    expect(tools).toContain('web_search');
  });
});
