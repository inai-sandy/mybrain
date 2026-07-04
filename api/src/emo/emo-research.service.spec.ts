import { EmoResearchService } from './emo-research.service';

function make(opts: { card: any; brief?: string; clarify?: string; result?: string }) {
  const updates: any[] = [];
  const cards: any = { get: jest.fn(async () => opts.card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return {}; }) };
  const llm: any = { complete: jest.fn(async (prompt: string) => (prompt.includes('research brief') ? (opts.brief ?? '{"topic":"CCTV market","question":"What is the CCTV market in India?"}') : (opts.clarify ?? '{"questions":["What angle?"],"options":["Overview","Competitors"]}'))) };
  const flows: any = { create: jest.fn(async () => ({ id: 'f1' })), planAndSave: jest.fn(async () => ({ id: 'f1' })) };
  const agent: any = { createRun: jest.fn(async () => ({ id: 'run1' })), getRun: jest.fn(async () => ({ resultText: opts.result ?? '## CCTV\n- finding [src]', status: 'done' })) };
  const bridge: any = { execute: jest.fn(async () => undefined) };
  return { svc: new EmoResearchService(llm, cards, flows, agent, bridge), cards, flows, agent, bridge, updates };
}

describe('EmoResearchService — Deep (BEA-870)', () => {
  it('clarifies first on a fresh deep-research card', async () => {
    const { svc, flows, updates } = make({ card: { id: 'c1', lane: 'research', rawTranscript: 'research the cctv market', summary: 'Research: CCTV', status: 'cooking', needsAnswer: null } });
    await svc.handle('c1');
    expect(flows.create).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'needs_you' });
  });

  it('builds & saves a flow (does NOT run it) once answered', async () => {
    const { svc, flows, updates } = make({ card: { id: 'c1', lane: 'research', rawTranscript: 'research the cctv market', summary: 'Research: CCTV', status: 'needs_you', needsAnswer: 'competitors' } });
    await svc.handle('c1');
    expect(flows.create).toHaveBeenCalled();
    expect(flows.planAndSave).toHaveBeenCalledWith('f1');
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Research flow ready: CCTV market');
    expect(done.links[0]).toMatchObject({ kind: 'flow', id: 'f1' });
  });
});

describe('EmoResearchService — Quick (BEA-871)', () => {
  it('runs immediately (no clarify) when the word "quick" is present', async () => {
    const { svc, agent, bridge, flows, updates } = make({ card: { id: 'c1', lane: 'research', rawTranscript: 'quick research on NVR pricing', summary: 'Research: NVR', status: 'cooking', needsAnswer: null } });
    await svc.handle('c1');
    expect(flows.create).not.toHaveBeenCalled(); // no flow built for quick
    expect(agent.createRun).toHaveBeenCalled();
    expect(bridge.execute).toHaveBeenCalled();
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
