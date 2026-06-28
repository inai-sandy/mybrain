import { HermesBridgeService } from './hermes-bridge.service';

function fakeAgent() {
  const steps: any[] = [];
  const runs: Record<string, any> = { 'run-1': { id: 'run-1', status: 'running' } };
  return {
    steps,
    runs,
    createRun: jest.fn(async (i: any) => { runs['run-1'] = { id: 'run-1', status: 'running', ...i }; return runs['run-1']; }),
    appendStep: jest.fn(async (runId: string, s: any) => { steps.push({ runId, ...s }); return runs[runId]; }),
    attachOutput: jest.fn(async (runId: string, docId: string) => { runs[runId].outputDocId = docId; return runs[runId]; }),
    finishRun: jest.fn(async (runId: string, patch: any) => { Object.assign(runs[runId], patch, { ended: true }); return runs[runId]; }),
  };
}
function fakeDocs() {
  return { create: jest.fn(async (i: any) => ({ id: 'doc-1', slug: 'agent-result-x', title: i.title })) };
}
/** Build a fake HermesClient whose runTurn drives the handlers then resolves with `result`. */
function fakeHermes(behaviour: (handlers: any) => Promise<any>) {
  return { runTurn: jest.fn(async (_text: string, handlers: any, _opts: any) => behaviour(handlers)) };
}

describe('HermesBridgeService (BEA-618)', () => {
  it('streams steps and saves the result as a Document on success', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const hermes = fakeHermes(async (h) => {
      h.onStep?.({ label: 'Searching the web', status: 'running', kind: 'tool' });
      h.onStep?.({ label: 'Searching the web', status: 'done', kind: 'tool' });
      return { sessionId: 's1', finalText: '# Findings\nvendor options...', status: 'complete' };
    });
    const svc = new HermesBridgeService(hermes as any, agent as any, docs as any);

    await svc.execute('run-1', { prompt: 'research vendors', title: 'Vendor research' });

    // tool steps mirrored
    expect(agent.steps.some((s) => s.label === 'Searching the web' && s.status === 'done')).toBe(true);
    // saved to documents with the final text
    expect(docs.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Vendor research', contentText: '# Findings\nvendor options...', kind: 'md' }));
    expect(agent.attachOutput).toHaveBeenCalledWith('run-1', 'doc-1');
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', outputDocId: 'doc-1' });
  });

  it('auto-denies risky commands and notes questions, then still completes', async () => {
    const agent = fakeAgent();
    const captured: any = {};
    const hermes = fakeHermes(async (h) => {
      captured.approval = await h.onApproval?.({ command: 'rm -rf /', description: 'danger' });
      captured.clarify = await h.onClarify?.({ question: 'Which angle?' });
      return { sessionId: 's1', finalText: 'done', status: 'complete' };
    });
    const svc = new HermesBridgeService(hermes as any, agent as any, fakeDocs() as any);
    await svc.execute('run-1', { prompt: 'x' });

    expect(captured.approval).toBe('deny'); // never auto-runs dangerous commands
    expect(typeof captured.clarify).toBe('string');
    expect(agent.steps.some((s) => /risky command/i.test(s.label))).toBe(true);
    expect(agent.steps.some((s) => /had a question/i.test(s.label))).toBe(true);
  });

  it('marks the run failed (no document) when the engine errors', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const hermes = fakeHermes(async () => ({ sessionId: 's1', finalText: '', status: 'error', error: 'model blew up' }));
    const svc = new HermesBridgeService(hermes as any, agent as any, docs as any);
    await svc.execute('run-1', { prompt: 'x' });
    expect(docs.create).not.toHaveBeenCalled();
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: 'model blew up' });
  });

  it('turns a connection failure into a friendly message', async () => {
    const agent = fakeAgent();
    const hermes = { runTurn: jest.fn(async () => { throw new Error('fetch failed'); }) };
    const svc = new HermesBridgeService(hermes as any, agent as any, fakeDocs() as any);
    await svc.execute('run-1', { prompt: 'x' });
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: expect.stringMatching(/reach the agent engine/i) });
  });

  it('save:false completes without writing a Document', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const hermes = fakeHermes(async () => ({ sessionId: 's1', finalText: 'just chat', status: 'complete' }));
    const svc = new HermesBridgeService(hermes as any, agent as any, docs as any);
    await svc.execute('run-1', { prompt: 'x', save: false });
    expect(docs.create).not.toHaveBeenCalled();
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done' });
  });

  it('startRun creates the run row and returns it immediately', async () => {
    const agent = fakeAgent();
    const hermes = fakeHermes(async () => ({ sessionId: 's1', finalText: 'x', status: 'complete' }));
    const svc = new HermesBridgeService(hermes as any, agent as any, fakeDocs() as any);
    const run = await svc.startRun({ prompt: 'go', title: 'T' });
    expect(run.id).toBe('run-1');
    expect(agent.createRun).toHaveBeenCalled();
  });
});
