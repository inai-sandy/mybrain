import { HermesBridgeService } from './hermes-bridge.service';

/**
 * BEA-1357 — a Social agent's run never starts an engine turn for the fetch. `execute()` forks to
 * the direct runner BEFORE the toolbox, the prompt and the Codex call; an ordinary job still takes
 * the engine road. Also: the WhatsApp "no number" message is said on the engine road too.
 */
function bridge(job: any, socialRuns: any, extra: Partial<Record<string, any>> = {}) {
  const steps: any[] = [];
  const agent: any = {
    appendStep: async (_id: string, s: any) => { steps.push(s); },
    getAgent: async () => job,
    engineSettings: async () => { throw new Error('ENGINE SETTINGS READ — the engine road was taken'); },
    finishRun: async () => undefined,
    ...extra,
  };
  const b = new HermesBridgeService(agent, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, undefined, socialRuns);
  return { b, steps };
}

describe('a Social agent fetches directly — no engine turn (BEA-1357)', () => {
  const social = { id: 'ag1', name: 'IG', tools: ['svc:instagram.search'], toolArgs: { 'svc:instagram.search': { query: 'x' } } };

  it('execute() hands a direct-fetch job to the social runner and never reaches the engine', async () => {
    const run = jest.fn(async () => undefined);
    const socialRuns = { handles: (a: any) => a.id === 'ag1', run };
    const realFetch = global.fetch;
    (global as any).fetch = jest.fn(async () => { throw new Error('ENGINE CALLED'); });
    try {
      const { b } = bridge(social, socialRuns);
      await b.execute('run1', { prompt: 'Keep every result as fetched.', agentId: 'ag1', title: 'IG' });
      expect(run).toHaveBeenCalledWith('run1', social, { title: 'IG' });
      expect((global as any).fetch).not.toHaveBeenCalled(); // no codex-runner call at all
    } finally {
      (global as any).fetch = realFetch;
    }
  });

  it('an ordinary job is NOT taken by the social runner (it goes on to the engine road)', async () => {
    const run = jest.fn(async () => undefined);
    const socialRuns = { handles: () => false, run };
    const { b } = bridge({ id: 'ag2', tools: [] }, socialRuns);
    await expect(b.execute('run2', { prompt: 'research x', agentId: 'ag2' })).rejects.toThrow(/ENGINE SETTINGS READ/);
    expect(run).not.toHaveBeenCalled();
  });

  it('a run with no agent never asks the social runner', async () => {
    const socialRuns = { handles: jest.fn(() => true), run: jest.fn() };
    const { b } = bridge(null, socialRuns);
    await expect(b.execute('run3', { prompt: 'quick ask' })).rejects.toThrow(/ENGINE SETTINGS READ/);
    expect(socialRuns.handles).not.toHaveBeenCalled();
  });
});

describe('the engine road honours outputDest sheet (BEA-1357) — the setting is never a dead switch', () => {
  function engineBridge(job: any, socialRuns: any) {
    const steps: any[] = [];
    const finish: any[] = [];
    const docs = { create: jest.fn(async () => ({ id: 'doc1', title: 'T' })), listCollections: async () => ({ collections: [] }), createCollection: async () => ({ id: 'c1' }) };
    const agent: any = {
      appendStep: async (_id: string, s: any) => { steps.push(s); },
      getAgent: async () => job,
      getRun: async () => ({ status: 'running', waitpoints: [] }),
      engineSettings: async () => ({ model: 'gpt', autonomy: 'autopilot', askTimeoutMin: 1, recall: false, learn: false }),
      outcomeFor: async () => ({ rubric: '', checks: [] }),
      allowedTools: async () => ({ ids: [], source: 'none' }),
      finishRun: async (_id: string, p: any) => { finish.push(p); },
      attachOutput: async () => undefined,
    };
    const llm: any = { recordUsage: async () => undefined, completeHelper: async () => null };
    const b: any = new HermesBridgeService(agent, docs as any, {} as any, {} as any, llm, { send: async () => ({}) } as any, undefined, undefined, undefined, undefined, undefined, socialRuns);
    // the engine turn itself is stubbed — this test is about what happens AFTER the answer
    b.runViaCodex = async () => ({ sessionId: 's', finalText: 'Legrand — Mumbai', status: 'ok' });
    return { b, steps, finish, docs };
  }
  const ordinary = { id: 'ag7', name: 'Brands', tools: [], toolArgs: null, outputDest: 'sheet', prompt: 'list brands' };

  it('writes the answer to a sheet and links the run — no Document, outputUrl set', async () => {
    const deliver = jest.fn(async () => ({ url: 'https://docs.google.com/spreadsheets/d/S9', rows: 2, created: true }));
    const { b, finish, docs } = engineBridge(ordinary, { handles: () => false, run: jest.fn(), deliverTextToSheet: deliver });
    await b.execute('run7', { prompt: 'list brands', agentId: 'ag7', title: 'Brands', allowAsk: false });
    expect(deliver).toHaveBeenCalledWith('run7', ordinary, 'Brands', 'Legrand — Mumbai');
    expect(finish[0]).toMatchObject({ status: 'done', outputUrl: 'https://docs.google.com/spreadsheets/d/S9', resultText: 'Legrand — Mumbai' });
    expect(docs.create).not.toHaveBeenCalled();
  });
  it('a sheet that cannot be written FAILS the run with the reason — never a quiet fallback to Documents', async () => {
    const deliver = jest.fn(async () => { throw new Error('Connect Google Sheets first — open /tools, connect Google Sheets, then run this job again.'); });
    const { b, finish, docs, steps } = engineBridge(ordinary, { handles: () => false, run: jest.fn(), deliverTextToSheet: deliver });
    await b.execute('run8', { prompt: 'list brands', agentId: 'ag7', title: 'Brands', allowAsk: false });
    expect(finish[0].status).toBe('failed');
    expect(finish[0].error).toMatch(/^Connect Google Sheets first/);
    expect(docs.create).not.toHaveBeenCalled();
    expect(steps.some((s) => s.status === 'failed')).toBe(true);
  });
  it('a job set to Documents still saves a Document (nothing else changed)', async () => {
    const { b, finish, docs } = engineBridge({ ...ordinary, outputDest: 'document' }, { handles: () => false, run: jest.fn(), deliverTextToSheet: jest.fn() });
    await b.execute('run9', { prompt: 'list brands', agentId: 'ag7', title: 'Brands', allowAsk: false });
    expect(docs.create).toHaveBeenCalledTimes(1);
    expect(finish[0]).toMatchObject({ status: 'done', outputDocId: 'doc1' });
  });
});
