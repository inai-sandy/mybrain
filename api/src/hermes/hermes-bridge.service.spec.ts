import { HermesBridgeService } from './hermes-bridge.service';

function fakeAgent(opts: { answer?: string; cfg?: any } = {}) {
  const steps: any[] = [];
  const runs: Record<string, any> = { 'run-1': { id: 'run-1', status: 'running' } };
  return {
    steps,
    runs,
    learnings: null as any,
    asked: [] as any[],
    engineSettings: jest.fn(async () => ({ model: '', autonomy: 'cautious', askTimeoutMin: 20, recall: true, learn: true, outputCollectionId: null, ...(opts.cfg || {}) })),
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
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', outputDocId: 'doc-1', resultText: '# Findings' });
  });

  it('BEA-624 recall: prepends brain context to the task and logs a step', async () => {
    const agent = fakeAgent();
    let seenPrompt = '';
    const hermes = fakeHermes(async (h) => { seenPrompt = h._text; return { sessionId: 's', finalText: 'ok', status: 'complete' }; });
    const mem = fakeMem([{ title: 'Ravi', content: 'prefers WhatsApp' }]);
    await build(hermes, agent, mem, fakeLlm()).execute('run-1', { prompt: 'draft a note to Ravi' });
    expect(mem.searchBrain).toHaveBeenCalledWith('draft a note to Ravi', 18);
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

  it('autopilot autonomy never asks: clarify proceeds with default, approval is denied without a Telegram ping', async () => {
    const agent = fakeAgent({ cfg: { autonomy: 'autopilot' } });
    const tg = fakeTg();
    let clarifyAns: any, approveAns: any;
    const hermes = fakeHermes(async (h) => {
      clarifyAns = await h.onClarify?.({ question: 'Which?', choices: ['a', 'b'] });
      approveAns = await h.onApproval?.({ command: 'rm' });
      return { sessionId: 's', finalText: 'ok', status: 'complete' };
    });
    await build(hermes, agent, fakeMem(), fakeLlm(), fakeDocs(), tg).execute('run-1', { prompt: 'x' });
    expect(clarifyAns).toBe('a'); // proceeded with the first choice, no waitpoint
    expect(approveAns).toBe('deny'); // never auto-runs risky
    expect(agent.ask).not.toHaveBeenCalled();
    expect(tg.pushAgentQuestion).not.toHaveBeenCalled();
  });

  it('recall off (setting) skips the brain search', async () => {
    const agent = fakeAgent({ cfg: { recall: false } });
    const mem = fakeMem([{ title: 'x', content: 'y' }]);
    await build(fakeHermes(async () => ({ sessionId: 's', finalText: 'ok', status: 'complete' })), agent, mem).execute('run-1', { prompt: 'x' });
    expect(mem.searchBrain).not.toHaveBeenCalled();
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

  it('BEA-630 quick mode: keeps recall (grounded) but skips learn-after and saving; stores the answer inline', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const mem = fakeMem([{ title: 'X', content: 'context' }]);
    const llm = fakeLlm('a durable fact');
    let seenPrompt = '';
    const hermes = fakeHermes(async (h) => { seenPrompt = h._text; return { sessionId: 's', finalText: 'the quick answer', status: 'complete' }; });
    await build(hermes, agent, mem, llm, docs).execute('run-1', { prompt: 'what is X?', quick: true });
    expect(mem.searchBrain).toHaveBeenCalled();         // recall stays (cheap + keeps it grounded)
    expect(seenPrompt).toContain('context');            // brain context injected
    expect(agent.setLearnings).not.toHaveBeenCalled();  // no learn-after
    expect(docs.create).not.toHaveBeenCalled();         // no document save
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', resultText: 'the quick answer' });
  });

  it('BEA-641 grades the result against the Outcome rubric and stores it', async () => {
    const agent = fakeAgent();
    const hermes = fakeHermes(async () => ({ sessionId: 's', finalText: 'the answer', status: 'complete' }));
    const llm = fakeLlm('{"verdict":"pass","score":90,"criteria":[{"text":"covers X","met":true}],"notes":"looks good"}');
    await build(hermes, agent, fakeMem(), llm).execute('run-1', { prompt: 'x', save: false, rubric: 'Must cover X' });
    const graded = (agent.finishRun as jest.Mock).mock.calls.find((c) => c[1]?.grade);
    expect(graded).toBeTruthy();
    expect(JSON.parse(graded[1].grade)).toMatchObject({ verdict: 'pass', score: 90 });
  });

  it('BEA-641 does not grade when no rubric is set', async () => {
    const agent = fakeAgent();
    const hermes = fakeHermes(async () => ({ sessionId: 's', finalText: 'the answer', status: 'complete' }));
    await build(hermes, agent, fakeMem(), fakeLlm('{}')).execute('run-1', { prompt: 'x', save: false });
    expect((agent.finishRun as jest.Mock).mock.calls.every((c) => !c[1]?.grade)).toBe(true);
  });

  it('BEA-643 draftAgent turns an idea into a config (name, task, bulleted outcome, evals)', async () => {
    const llm = fakeLlm('Sure! {"name":"Email Triage","task":"summarise unread emails","outcome":["one line each","flag urgent"],"evals":["3 emails","CEO request"]}');
    const out = await build(fakeHermes(async () => ({ sessionId: 's', finalText: '', status: 'complete' })), fakeAgent(), fakeMem(), llm).draftAgent('summarise my emails');
    expect(out.name).toBe('Email Triage');
    expect(out.prompt).toContain('summarise');
    expect(out.rubric).toBe('- one line each\n- flag urgent');
    expect(out.evals).toEqual(['3 emails', 'CEO request']);
  });

  it('BEA-642 runEvals grades each case against the Outcome and records verdicts', async () => {
    const evals = [{ id: 'e1', input: 'case one' }, { id: 'e2', input: 'case two' }];
    const runs: Record<string, any> = {};
    let saved: any[] = [];
    const agent: any = {
      getAgent: jest.fn(async () => ({ id: 'a1', name: 'A', prompt: 'do it', rubric: 'must be good', evals })),
      getRun: jest.fn(async (id: string) => ({ ...runs[id], grade: { verdict: 'pass', score: 88 } })),
      createRun: jest.fn(async (i: any) => { const id = 'run-' + Object.keys(runs).length; runs[id] = { id, ...i, status: 'running' }; return runs[id]; }),
      appendStep: jest.fn(async () => undefined),
      finishRun: jest.fn(async (id: string, p: any) => { Object.assign(runs[id], p); return runs[id]; }),
      setEvals: jest.fn(async (_id: string, e: any) => { saved = JSON.parse(JSON.stringify(e)); }),
      engineSettings: jest.fn(async () => ({ model: '', autonomy: 'cautious', askTimeoutMin: 20, recall: false, learn: false, outputCollectionId: null })),
    };
    const hermes = fakeHermes(async () => ({ sessionId: 's', finalText: 'an answer', status: 'complete' }));
    const llm = fakeLlm('{"verdict":"pass","score":88,"criteria":[],"notes":"ok"}');
    await build(hermes, agent, fakeMem(), llm).runEvals('a1');
    expect(agent.setEvals).toHaveBeenCalled();
    expect(saved.length).toBe(2);
    expect(saved.every((c: any) => c.lastVerdict === 'pass' && c.lastRunId)).toBe(true);
  });

  it('BEA-630 normal mode still stores the answer text inline (resultText)', async () => {
    const agent = fakeAgent();
    const hermes = fakeHermes(async () => ({ sessionId: 's', finalText: 'big result text', status: 'complete' }));
    await build(hermes, agent, fakeMem(), fakeLlm()).execute('run-1', { prompt: 'x', save: false });
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', resultText: 'big result text' });
  });
});
