import { EmoSearchService } from './emo-search.service';

function make(overrides: any = {}) {
  const updates: any[] = [];
  const cards: any = {
    get: jest.fn(async () => overrides.card ?? { id: 'c1', lane: 'search', rawTranscript: 'what do we have on the CCTV market', summary: 'Search: CCTV market', needsAnswer: null }),
    update: jest.fn(async (_id: string, patch: any) => { updates.push(patch); return { id: 'c1', ...patch }; }),
  };
  const llm: any = { complete: jest.fn(async () => overrides.clarify ?? '{"questions":["Which region?","Done or pending?"],"options":["South India","All India","Last 30 days"]}') };
  const agent: any = { createRun: jest.fn(async () => ({ id: 'run1' })), getRun: jest.fn(async () => ({ resultText: '## CCTV market\n- Finding one [source]', status: 'done' })) };
  const bridge: any = { execute: jest.fn(async () => undefined) };
  return { svc: new EmoSearchService(llm, cards, agent, bridge), cards, llm, agent, bridge, updates };
}

describe('EmoSearchService (BEA-869)', () => {
  it('clarify puts 2–3 questions + chips on the card and sets Needs-you', async () => {
    const { svc, updates } = make();
    await svc.clarify('c1');
    expect(updates[0].status).toBe('needs_you');
    expect(updates[0].needsQuestion).toMatch(/region/i);
    expect(updates[0].needsOptions).toContain('South India');
  });

  it('clarify falls back to a generic question when the LLM gives nothing', async () => {
    const { svc, updates } = make({ clarify: 'sorry' });
    await svc.clarify('c1');
    expect(updates[0].status).toBe('needs_you');
    expect(updates[0].needsQuestion).toMatch(/narrow it down/i);
    expect(updates[0].needsOptions).toContain('Search everything');
  });

  it('run executes the search agent and writes a curated result (done)', async () => {
    const { svc, agent, bridge, updates } = make({ card: { id: 'c1', lane: 'search', rawTranscript: 'cctv market', summary: 'Search: CCTV', needsAnswer: 'South India, last 30 days' } });
    await svc.run('c1');
    expect(agent.createRun).toHaveBeenCalled();
    expect(bridge.execute).toHaveBeenCalled();
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.detail).toMatch(/CCTV market/);
    expect(done.links[0]).toMatchObject({ kind: 'agent', id: 'run1' });
  });

  it('run marks the card done with an error note if the agent throws', async () => {
    const { svc } = make();
    (svc as any).bridge.execute = jest.fn(async () => { throw new Error('engine down'); });
    const updates: any[] = [];
    (svc as any).cards.update = jest.fn(async (_id: string, p: any) => { updates.push(p); return {}; });
    await svc.run('c1');
    expect(updates[updates.length - 1].status).toBe('done');
    expect(updates[updates.length - 1].detail).toMatch(/failed/i);
  });

  it('ignores a non-search card', async () => {
    const { svc, cards } = make({ card: { id: 'c1', lane: 'task' } });
    await svc.clarify('c1');
    expect(cards.update).not.toHaveBeenCalled();
  });
});
