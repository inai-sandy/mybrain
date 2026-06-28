import { HermesBridgeService } from './hermes-bridge.service';

function fakeAgent(opts: { answer?: string } = {}) {
  const steps: any[] = [];
  const runs: Record<string, any> = { 'run-1': { id: 'run-1', status: 'running' } };
  return {
    steps,
    runs,
    asked: [] as any[],
    createRun: jest.fn(async (i: any) => { runs['run-1'] = { id: 'run-1', status: 'running', ...i }; return runs['run-1']; }),
    appendStep: jest.fn(async (runId: string, s: any) => { steps.push({ runId, ...s }); return runs[runId]; }),
    attachOutput: jest.fn(async (runId: string, docId: string) => { runs[runId].outputDocId = docId; return runs[runId]; }),
    finishRun: jest.fn(async (runId: string, patch: any) => { Object.assign(runs[runId], patch, { ended: true }); return runs[runId]; }),
    // HITL relay (BEA-620)
    ask: jest.fn(async function (this: any, runId: string, q: any) { this.asked.push({ runId, ...q }); return { id: 'wp1', resumeToken: 'tok', status: 'pending', kind: q.kind, options: q.options }; }),
    getWaitpoint: jest.fn(async (_token: string) => ({ status: 'answered', answer: opts.answer ?? 'speed', defaultValue: null })),
  };
}
function fakeDocs() {
  return { create: jest.fn(async (i: any) => ({ id: 'doc-1', slug: 'agent-result-x', title: i.title })) };
}
function fakeTelegram() {
  return { pushAgentQuestion: jest.fn(async () => undefined) };
}
function fakeHermes(behaviour: (handlers: any) => Promise<any>) {
  return { runTurn: jest.fn(async (_t: string, handlers: any) => behaviour(handlers)) };
}

describe('HermesBridgeService (BEA-618 + BEA-620)', () => {
  it('streams steps and saves the result as a Document on success', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const hermes = fakeHermes(async (h) => {
      h.onStep?.({ label: 'Searching the web', status: 'running', kind: 'tool' });
      h.onStep?.({ label: 'Searching the web', status: 'done', kind: 'tool' });
      return { sessionId: 's1', finalText: '# Findings\nvendor options...', status: 'complete' };
    });
    const svc = new HermesBridgeService(hermes as any, agent as any, docs as any, fakeTelegram() as any);
    await svc.execute('run-1', { prompt: 'research vendors', title: 'Vendor research' });
    expect(agent.steps.some((s) => s.label === 'Searching the web' && s.status === 'done')).toBe(true);
    expect(docs.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Vendor research', contentText: '# Findings\nvendor options...' }));
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', outputDocId: 'doc-1' });
  });

  it('BEA-620: relays a clarify question to the human and returns their choice', async () => {
    const agent = fakeAgent({ answer: 'speed' });
    const tg = fakeTelegram();
    let returned: any;
    const hermes = fakeHermes(async (h) => {
      returned = await h.onClarify?.({ question: 'Which angle?', choices: ['cost', 'speed'] });
      return { sessionId: 's1', finalText: 'done', status: 'complete' };
    });
    const svc = new HermesBridgeService(hermes as any, agent as any, fakeDocs() as any, tg as any);
    await svc.execute('run-1', { prompt: 'x', title: 'T' });
    expect(agent.ask).toHaveBeenCalledWith('run-1', expect.objectContaining({ kind: 'choice', options: ['cost', 'speed'] }));
    expect(tg.pushAgentQuestion).toHaveBeenCalled(); // asked over Telegram
    expect(returned).toBe('speed'); // the user's answer flows back to the engine
  }, 15000);

  it('BEA-620: relays an approval and maps approve->once / reject->deny', async () => {
    const approve = fakeAgent({ answer: 'approve' });
    let choice: any;
    const h1 = fakeHermes(async (h) => { choice = await h.onApproval?.({ command: 'rm file', description: 'danger' }); return { sessionId: 's', finalText: 'ok', status: 'complete' }; });
    await new HermesBridgeService(h1 as any, approve as any, fakeDocs() as any, fakeTelegram() as any).execute('run-1', { prompt: 'x' });
    expect(choice).toBe('once');

    const reject = fakeAgent({ answer: 'reject' });
    let choice2: any;
    const h2 = fakeHermes(async (h) => { choice2 = await h.onApproval?.({ command: 'rm file' }); return { sessionId: 's', finalText: 'ok', status: 'complete' }; });
    await new HermesBridgeService(h2 as any, reject as any, fakeDocs() as any, fakeTelegram() as any).execute('run-1', { prompt: 'x' });
    expect(choice2).toBe('deny');
  }, 15000);

  it('marks the run failed (no document) when the engine errors', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const hermes = fakeHermes(async () => ({ sessionId: 's1', finalText: '', status: 'error', error: 'model blew up' }));
    const svc = new HermesBridgeService(hermes as any, agent as any, docs as any, fakeTelegram() as any);
    await svc.execute('run-1', { prompt: 'x' });
    expect(docs.create).not.toHaveBeenCalled();
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: 'model blew up' });
  });

  it('turns a connection failure into a friendly message', async () => {
    const agent = fakeAgent();
    const hermes = { runTurn: jest.fn(async () => { throw new Error('fetch failed'); }) };
    const svc = new HermesBridgeService(hermes as any, agent as any, fakeDocs() as any, fakeTelegram() as any);
    await svc.execute('run-1', { prompt: 'x' });
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: expect.stringMatching(/reach the agent engine/i) });
  });

  it('startRun creates the run row and returns it immediately', async () => {
    const agent = fakeAgent();
    const hermes = fakeHermes(async () => ({ sessionId: 's1', finalText: 'x', status: 'complete' }));
    const svc = new HermesBridgeService(hermes as any, agent as any, fakeDocs() as any, fakeTelegram() as any);
    const run = await svc.startRun({ prompt: 'go', title: 'T' });
    expect(run.id).toBe('run-1');
  });
});
