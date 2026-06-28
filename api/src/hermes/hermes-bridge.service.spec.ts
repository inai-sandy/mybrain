import { HermesBridgeService } from './hermes-bridge.service';

function fakeAgent(opts: { answer?: string } = {}) {
  const steps: any[] = [];
  const runs: Record<string, any> = { 'run-1': { id: 'run-1', status: 'running' } };
  return {
    steps,
    runs,
    learnings: null as any,
    asked: [] as any[],
    createRun: jest.fn(async (i: any) => { runs['run-1'] = { id: 'run-1', status: 'running', ...i }; return runs['run-1']; }),
    appendStep: jest.fn(async (runId: string, s: any) => { steps.push({ runId, ...s }); return runs[runId]; }),
    attachOutput: jest.fn(async (runId: string, docId: string) => { runs[runId].outputDocId = docId; return runs[runId]; }),
    finishRun: jest.fn(async (runId: string, patch: any) => { Object.assign(runs[runId], patch, { ended: true }); return runs[runId]; }),
    setLearnings: jest.fn(async function (this: any, _runId: string, items: any) { this.learnings = items; return runs['run-1']; }),
    ask: jest.fn(async function (this: any, runId: string, q: any) { this.asked.push({ runId, ...q }); return { id: 'wp1', resumeToken: 'tok', status: 'pending', kind: q.kind, options: q.options }; }),
    getWaitpoint: jest.fn(async (_token: string) => ({ status: 'answered', answer: opts.answer ?? 'speed', defaultValue: null })),
  };
}
const fakeDocs = () => ({ create: jest.fn(async (i: any) => ({ id: 'doc-1', slug: 'x', title: i.title })) });
const fakeTg = () => ({ pushAgentQuestion: jest.fn(async () => undefined) });
const fakeMem = (hits: any[] = []) => ({ searchBrain: jest.fn(async () => hits), enqueue: jest.fn(async () => undefined) });
const fakeLlm = (out = '') => ({ complete: jest.fn(async () => out) });
const fakeHermes = (behaviour: (h: any) => Promise<any>) => ({ runTurn: jest.fn(async (text: string, h: any) => behaviour({ ...h, _text: text })) });

function build(hermes: any, agent: any, mem = fakeMem(), llm = fakeLlm(), docs = fakeDocs(), tg = fakeTg()) {
  return new HermesBridgeService(hermes as any, agent as any, docs as any, tg as any, mem as any, llm as any);
}

describe('HermesBridgeService (618 + 620 + 624)', () => {
  it('streams steps and saves the result as a Document on success', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const hermes = fakeHermes(async (h) => { h.onStep?.({ label: 'Searching the web', status: 'done' }); return { sessionId: 's', finalText: '# Findings', status: 'complete' }; });
    await build(hermes, agent, fakeMem(), fakeLlm(), docs).execute('run-1', { prompt: 'research', title: 'Vendor research' });
    expect(docs.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Vendor research', contentText: '# Findings' }));
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', outputDocId: 'doc-1' });
  });

  it('BEA-624 recall: prepends brain context to the task and logs a step', async () => {
    const agent = fakeAgent();
    let seenPrompt = '';
    const hermes = fakeHermes(async (h) => { seenPrompt = h._text; return { sessionId: 's', finalText: 'ok', status: 'complete' }; });
    const mem = fakeMem([{ title: 'Ravi', content: 'prefers WhatsApp' }]);
    await build(hermes, agent, mem, fakeLlm()).execute('run-1', { prompt: 'draft a note to Ravi' });
    expect(mem.searchBrain).toHaveBeenCalledWith('draft a note to Ravi', 6);
    expect(seenPrompt).toContain('prefers WhatsApp'); // context injected
    expect(seenPrompt).toContain('Task: draft a note to Ravi');
    expect(agent.steps.some((s) => /Recalled 1 note/.test(s.label))).toBe(true);
  });

  it('BEA-624 learn: proposes durable facts from the result', async () => {
    const agent = fakeAgent();
    const hermes = fakeHermes(async () => ({ sessionId: 's', finalText: 'big result text', status: 'complete' }));
    const llm = fakeLlm('Ravi pays by Friday\nThe invoice is INV-204\n');
    await build(hermes, agent, fakeMem(), llm).execute('run-1', { prompt: 'x' });
    expect(agent.setLearnings).toHaveBeenCalled();
    expect(agent.learnings).toEqual([
      { text: 'Ravi pays by Friday', status: 'proposed' },
      { text: 'The invoice is INV-204', status: 'proposed' },
    ]);
  });

  it('BEA-620 relays a clarify question and returns the choice', async () => {
    const agent = fakeAgent({ answer: 'speed' });
    const tg = fakeTg();
    let returned: any;
    const hermes = fakeHermes(async (h) => { returned = await h.onClarify?.({ question: 'Which?', choices: ['cost', 'speed'] }); return { sessionId: 's', finalText: 'done', status: 'complete' }; });
    await build(hermes, agent, fakeMem(), fakeLlm(), fakeDocs(), tg).execute('run-1', { prompt: 'x' });
    expect(tg.pushAgentQuestion).toHaveBeenCalled();
    expect(returned).toBe('speed');
  }, 15000);

  it('BEA-620 approval maps approve->once / reject->deny', async () => {
    const a1 = fakeAgent({ answer: 'approve' }); let c1: any;
    await build(fakeHermes(async (h) => { c1 = await h.onApproval?.({ command: 'rm' }); return { sessionId: 's', finalText: 'ok', status: 'complete' }; }), a1).execute('run-1', { prompt: 'x' });
    expect(c1).toBe('once');
    const a2 = fakeAgent({ answer: 'reject' }); let c2: any;
    await build(fakeHermes(async (h) => { c2 = await h.onApproval?.({ command: 'rm' }); return { sessionId: 's', finalText: 'ok', status: 'complete' }; }), a2).execute('run-1', { prompt: 'x' });
    expect(c2).toBe('deny');
  }, 15000);

  it('marks the run failed (no document) when the engine errors', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    await build(fakeHermes(async () => ({ sessionId: 's', finalText: '', status: 'error', error: 'boom' })), agent, fakeMem(), fakeLlm(), docs).execute('run-1', { prompt: 'x' });
    expect(docs.create).not.toHaveBeenCalled();
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: 'boom' });
  });

  it('turns a connection failure into a friendly message', async () => {
    const agent = fakeAgent();
    const hermes = { runTurn: jest.fn(async () => { throw new Error('fetch failed'); }) };
    await build(hermes, agent).execute('run-1', { prompt: 'x' });
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: expect.stringMatching(/reach the agent engine/i) });
  });

  it('startRun creates the run row and returns it', async () => {
    const agent = fakeAgent();
    const run = await build(fakeHermes(async () => ({ sessionId: 's', finalText: 'x', status: 'complete' })), agent).startRun({ prompt: 'go', title: 'T' });
    expect(run.id).toBe('run-1');
  });
});
