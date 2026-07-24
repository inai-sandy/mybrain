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
    getRun: jest.fn(async (runId: string) => runs[runId] || null), // used to skip result-saving on a cancelled run (BEA-793)
    appendStep: jest.fn(async (runId: string, s: any) => { steps.push({ runId, ...s }); return runs[runId]; }),
    attachOutput: jest.fn(async (runId: string, docId: string) => { runs[runId].outputDocId = docId; return runs[runId]; }),
    finishRun: jest.fn(async (runId: string, patch: any) => { Object.assign(runs[runId], patch, { ended: true }); return runs[runId]; }),
    setLearnings: jest.fn(async function (this: any, _runId: string, items: any) { this.learnings = items; return runs['run-1']; }),
    setEvals: jest.fn(async () => undefined),
    // durable park + resume (BEA-795)
    parkRun: jest.fn(async (runId: string, sessionId?: string) => { runs[runId].sessionId = sessionId || ''; }),
    listResumable: jest.fn(async () => [] as any[]),
    pauseStaleAsks: jest.fn(async () => [] as any[]), // gentle TTL pause (BEA-1068)
    claimResume: jest.fn(async (runId: string) => { const had = runs[runId]?.sessionId != null; if (runs[runId]) runs[runId].sessionId = null; return had; }),
    getAgent: jest.fn(async () => null),
  };
}
const fakeDocs = () => ({ create: jest.fn(async (i: any) => ({ id: 'doc-1', slug: 'x', title: i.title })) });
const fakeTg = () => ({ pushAgentQuestion: jest.fn(async () => undefined), notifyAgentPaused: jest.fn(async () => undefined) });
const fakeMem = (hits: any[] = []) => ({ searchBrain: jest.fn(async () => hits), enqueue: jest.fn(async () => undefined) });
const fakeLlm = (out = '') => ({ complete: jest.fn(async () => out) });
const fakePush = () => ({ send: jest.fn(async () => ({ sent: 1, pruned: 0 })) });

// The engine is the host codex-runner, reached over HTTP. Mock global.fetch to drive a turn.
// resp: object or (body)=>object with { text?, events?, httpError?, error?, throw? }.
function mockCodex(resp: any = {}) {
  const fn = jest.fn(async (_url: string, init: any) => {
    const body = JSON.parse((init && init.body) || '{}');
    const r = (typeof resp === 'function' ? resp(body) : resp) || {};
    if (r.throw) throw new Error(r.throw);
    if (r.httpError) return { ok: false, json: async () => ({ error: r.error || 'boom' }) } as any;
    return { ok: true, json: async () => ({ text: r.text ?? 'ok', sessionId: 's', events: r.events ?? [] }) } as any;
  });
  (global as any).fetch = fn;
  return fn;
}

function build(agent: any, mem = fakeMem(), llm = fakeLlm(), docs = fakeDocs(), tg = fakeTg(), push = fakePush()) {
  return new HermesBridgeService(agent as any, docs as any, tg as any, mem as any, llm as any, push as any);
}

describe('HermesBridgeService (Codex engine)', () => {
  let savedFetch: any;
  beforeEach(() => { savedFetch = (global as any).fetch; });
  afterEach(() => { (global as any).fetch = savedFetch; });

  it('runs a turn via the codex-runner and saves the result as a Document', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const fetchMock = mockCodex({ text: '# Findings' });
    await build(agent, fakeMem(), fakeLlm(), docs).execute('run-1', { prompt: 'research', title: 'Vendor research' });
    expect(fetchMock).toHaveBeenCalledWith('http://172.18.0.1:8765/run', expect.objectContaining({ method: 'POST' }));
    expect(docs.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Vendor research', contentText: '# Findings' }));
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', outputDocId: 'doc-1', resultText: '# Findings' });
  });

  it('finalizes the run as failed if execute throws before its own try (BEA-799)', async () => {
    const agent = fakeAgent();
    agent.engineSettings = jest.fn(async () => { throw new Error('db down'); }); // throws before execute's try
    await build(agent).startRun({ prompt: 'hi', title: 'T' });
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget catch settle
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'failed' }));
  });

  it('surfaces a tool call (mybrain) as a step', async () => {
    const agent = fakeAgent();
    mockCodex({ text: 'ok', events: [{ type: 'mcp_tool_call', name: 'mybrain' }] });
    await build(agent).execute('run-1', { prompt: 'do it', title: 'T' });
    expect(agent.steps.some((s: any) => /Used your brain/.test(s.label))).toBe(true);
  });

  it('BEA-692 research-first: appends research-then-brain guidance, does NOT pre-inject the brain', async () => {
    const agent = fakeAgent();
    let seenPrompt = '';
    mockCodex((body: any) => { seenPrompt = body.prompt; return { text: 'ok' }; });
    const mem = fakeMem([{ title: 'Ravi', content: 'prefers WhatsApp' }]);
    await build(agent, mem, fakeLlm()).execute('run-1', { prompt: 'draft a note to Ravi' });
    expect(mem.searchBrain).not.toHaveBeenCalled(); // no pre-injected recall
    expect(seenPrompt).toContain('Research the topic properly FIRST');
    expect(seenPrompt).toContain('search_brain'); // brain is consulted as a tool, AFTER research
    expect(seenPrompt).not.toContain('prefers WhatsApp'); // not dumped into the prompt
    expect(agent.steps.some((s) => /Recalled/.test(s.label))).toBe(false);
  });

  it('BEA-624 learn: proposes durable facts from the result', async () => {
    const agent = fakeAgent();
    mockCodex({ text: 'big result text' });
    const llm = fakeLlm('Ravi pays by Friday\nThe invoice is INV-204\n');
    await build(agent, fakeMem(), llm).execute('run-1', { prompt: 'x' });
    expect(agent.setLearnings).toHaveBeenCalled();
    expect(agent.learnings).toEqual([
      { text: 'Ravi pays by Friday', status: 'proposed' },
      { text: 'The invoice is INV-204', status: 'proposed' },
    ]);
  });

  it('recall off (setting): brain is not offered as a tool, but it still researches', async () => {
    const agent = fakeAgent({ cfg: { recall: false } });
    const mem = fakeMem([{ title: 'x', content: 'y' }]);
    let seenPrompt = '';
    mockCodex((body: any) => { seenPrompt = body.prompt; return { text: 'ok' }; });
    await build(agent, mem).execute('run-1', { prompt: 'x' });
    expect(mem.searchBrain).not.toHaveBeenCalled();
    expect(seenPrompt).not.toContain('search_brain'); // brain disabled → not mentioned
    expect(seenPrompt).toContain('Research the topic'); // still researches
  });

  it('BEA-695 depth=standard saves a document; depth=quick does not', async () => {
    let agent = fakeAgent();
    let docs = fakeDocs();
    mockCodex({ text: 'an answer' });
    await build(agent, fakeMem(), fakeLlm(), docs).execute('run-1', { prompt: 'x', depth: 'standard' });
    expect(docs.create).toHaveBeenCalled();

    agent = fakeAgent();
    docs = fakeDocs();
    mockCodex({ text: 'an answer' });
    await build(agent, fakeMem(), fakeLlm(), docs).execute('run-1', { prompt: 'x', depth: 'quick' });
    expect(docs.create).not.toHaveBeenCalled(); // quick saves nothing
  });

  it('BEA-695 startRun records the chosen depth on the run', async () => {
    const agent = fakeAgent();
    mockCodex({ text: 'x' });
    await build(agent).startRun({ prompt: 'go', depth: 'quick' });
    expect(agent.createRun).toHaveBeenCalledWith(expect.objectContaining({ depth: 'quick' }));
  });

  it('BEA-696 fails the Outcome → revises exactly once (no loop)', async () => {
    const agent = fakeAgent();
    let codexCalls = 0;
    mockCodex(() => { codexCalls++; return { text: `answer ${codexCalls}` }; });
    const llm = fakeLlm('{"verdict":"fail","score":20,"criteria":[],"notes":"missing sources"}');
    await build(agent, fakeMem(), llm, fakeDocs()).execute('run-1', { prompt: 'x', rubric: 'must cite 3 sources', depth: 'standard' });
    expect(codexCalls).toBe(2); // initial + one revise, never more
  });

  it('BEA-696 passes the Outcome → no retry', async () => {
    const agent = fakeAgent();
    let codexCalls = 0;
    mockCodex(() => { codexCalls++; return { text: 'good answer' }; });
    const llm = fakeLlm('{"verdict":"pass","score":90,"criteria":[],"notes":"solid"}');
    await build(agent, fakeMem(), llm, fakeDocs()).execute('run-1', { prompt: 'x', rubric: 'r', depth: 'standard' });
    expect(codexCalls).toBe(1);
  });

  it('BEA-700 listSavedByAgents returns agent-tagged docs + brain learnings', async () => {
    const docs: any = { list: async () => ({ documents: [{ id: 'd1', title: 'Saved A', tags: ['agent'], description: 'x', createdAt: '2026-06-30' }, { id: 'd2', title: 'Note', tags: ['note'] }] }), remove: async () => undefined };
    const mem: any = { listRagByTag: async () => [{ id: 'l1', title: 'Agent learned' }] };
    const svc = new HermesBridgeService({} as any, docs, fakeTg() as any, mem, fakeLlm() as any, fakePush() as any);
    const res = await svc.listSavedByAgents();
    expect(res.documents.map((d: any) => d.id)).toEqual(['d1']); // only the 'agent'-tagged doc
    expect(res.brainLearnings).toHaveLength(1);
  });

  it('marks the run failed (no document) when the engine errors', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    mockCodex({ httpError: true, error: 'boom' });
    await build(agent, fakeMem(), fakeLlm(), docs).execute('run-1', { prompt: 'x' });
    expect(docs.create).not.toHaveBeenCalled();
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: 'boom' });
  });

  it('turns a connection failure into a friendly message', async () => {
    const agent = fakeAgent();
    mockCodex({ throw: 'fetch failed' });
    await build(agent).execute('run-1', { prompt: 'x' });
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'failed', error: expect.stringMatching(/reach the agent engine/i) });
  });

  it('startRun creates the run row and returns it', async () => {
    const agent = fakeAgent();
    mockCodex({ text: 'x' });
    const run = await build(agent).startRun({ prompt: 'go', title: 'T' });
    expect(run.id).toBe('run-1');
  });

  it('BEA-630 quick mode: research-aware, skips learn-after and saving; stores the answer inline', async () => {
    const agent = fakeAgent();
    const docs = fakeDocs();
    const mem = fakeMem([{ title: 'X', content: 'context' }]);
    const llm = fakeLlm('a durable fact');
    let seenPrompt = '';
    mockCodex((body: any) => { seenPrompt = body.prompt; return { text: 'the quick answer' }; });
    await build(agent, mem, llm, docs).execute('run-1', { prompt: 'what is X?', quick: true });
    expect(mem.searchBrain).not.toHaveBeenCalled(); // brain is a tool now, not pre-injected
    expect(seenPrompt).toContain('search_brain'); // recall on by default → offered as a tool
    expect(seenPrompt).toContain('Keep it short');
    expect(agent.setLearnings).not.toHaveBeenCalled();
    expect(docs.create).not.toHaveBeenCalled();
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', resultText: 'the quick answer' });
  });

  it('BEA-641 grades the result against the Outcome rubric and stores it', async () => {
    const agent = fakeAgent();
    mockCodex({ text: 'the answer' });
    const llm = fakeLlm('{"verdict":"pass","score":90,"criteria":[{"text":"covers X","met":true}],"notes":"looks good"}');
    await build(agent, fakeMem(), llm).execute('run-1', { prompt: 'x', save: false, rubric: 'Must cover X' });
    const graded = (agent.finishRun as jest.Mock).mock.calls.find((c) => c[1]?.grade);
    expect(graded).toBeTruthy();
    expect(JSON.parse(graded[1].grade)).toMatchObject({ verdict: 'pass', score: 90 });
  });

  it('BEA-641 does not grade when no rubric is set', async () => {
    const agent = fakeAgent();
    mockCodex({ text: 'the answer' });
    await build(agent, fakeMem(), fakeLlm('{}')).execute('run-1', { prompt: 'x', save: false });
    expect((agent.finishRun as jest.Mock).mock.calls.every((c) => !c[1]?.grade)).toBe(true);
  });

  it('BEA-643 draftAgent turns an idea into a config (name, task, bulleted outcome, evals)', async () => {
    const llm = fakeLlm('Sure! {"name":"Email Triage","task":"summarise unread emails","outcome":["one line each","flag urgent"],"evals":["3 emails","CEO request"]}');
    const out = await build(fakeAgent(), fakeMem(), llm).draftAgent('summarise my emails');
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
      setLearnings: jest.fn(async () => undefined),
      engineSettings: jest.fn(async () => ({ model: '', autonomy: 'cautious', askTimeoutMin: 20, recall: false, learn: false, outputCollectionId: null })),
    };
    mockCodex({ text: 'an answer' });
    const llm = fakeLlm('{"verdict":"pass","score":88,"criteria":[],"notes":"ok"}');
    await build(agent, fakeMem(), llm).runEvals('a1');
    expect(agent.setEvals).toHaveBeenCalled();
    expect(saved.length).toBe(2);
    expect(saved.every((c: any) => c.lastVerdict === 'pass' && c.lastRunId)).toBe(true);
  });

  it('BEA-630 normal mode still stores the answer text inline (resultText)', async () => {
    const agent = fakeAgent();
    mockCodex({ text: 'big result text' });
    await build(agent, fakeMem(), fakeLlm()).execute('run-1', { prompt: 'x', save: false });
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', { status: 'done', resultText: 'big result text' });
  });

  // ---- durable ask-me (BEA-795): park on ask, resume on answer ----

  it('BEA-795 offers the ask_user tool with the runId; allowAsk:false (flows/evals) leaves it out', async () => {
    const agent = fakeAgent();
    let seenPrompt = '';
    mockCodex((body: any) => { seenPrompt = body.prompt; return { text: 'ok' }; });
    await build(agent).execute('run-1', { prompt: 'task' });
    expect(seenPrompt).toContain('ask_user');
    expect(seenPrompt).toContain('runId "run-1"');

    seenPrompt = '';
    mockCodex((body: any) => { seenPrompt = body.prompt; return { text: 'ok' }; });
    await build(fakeAgent()).execute('run-1', { prompt: 'task', allowAsk: false });
    expect(seenPrompt).not.toContain('ask_user');
  });

  it('BEA-795 parks the run (sessionId kept, Telegram ping, NOT finished) when the model asked and ended its turn', async () => {
    const agent = fakeAgent();
    const tg = fakeTg();
    const docs = fakeDocs();
    // during the turn the model called ask_user → the REST tool flipped the run to awaiting_input
    mockCodex(() => {
      agent.runs['run-1'].status = 'awaiting_input';
      agent.runs['run-1'].waitpoints = [{ id: 'wp-1', status: 'pending', question: 'Which vendor?', kind: 'choice', options: ['A', 'B'] }];
      return { text: 'I asked the user and am waiting.' };
    });
    await build(agent, fakeMem(), fakeLlm(), docs, tg).execute('run-1', { prompt: 'research then ask', title: 'Vendors' });
    expect(agent.parkRun).toHaveBeenCalledWith('run-1', 's'); // the engine session is kept on the row
    expect(tg.pushAgentQuestion).toHaveBeenCalledWith(expect.objectContaining({ question: 'Which vendor?' }));
    expect(agent.finishRun).not.toHaveBeenCalled(); // finishing would cancel the pending question
    expect(docs.create).not.toHaveBeenCalled(); // the parting note is not saved as a result
    expect(agent.steps.some((s: any) => /waiting for your answer/i.test(s.label))).toBe(true);
  });

  it('BEA-795 parking wins over a turn error — the question survives an engine timeout', async () => {
    const agent = fakeAgent();
    mockCodex(() => {
      agent.runs['run-1'].status = 'awaiting_input';
      agent.runs['run-1'].waitpoints = [{ id: 'wp-1', status: 'pending', question: 'q' }];
      return { httpError: true, error: 'timed out' };
    });
    await build(agent).execute('run-1', { prompt: 'x' });
    expect(agent.parkRun).toHaveBeenCalled();
    expect(agent.finishRun).not.toHaveBeenCalled();
  });

  it('BEA-795 resumeTick claims an answered park exactly once and resumes the SAME engine session', async () => {
    const agent = fakeAgent();
    agent.runs['run-1'] = {
      id: 'run-1', status: 'running', sessionId: 'sess-42', input: 'the original task', title: 'T', agentId: null, depth: 'standard',
      waitpoints: [{ id: 'wp-1', status: 'answered', question: 'Colour?', answer: 'blue', answeredAt: '2026-07-24T06:00:00Z' }],
    };
    agent.listResumable = jest.fn(async () => [agent.runs['run-1']]);
    let seenBody: any = null;
    mockCodex((body: any) => { seenBody = body; return { text: 'finished with blue' }; });
    const svc = build(agent);
    await svc.resumeTick();
    await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget resume settle
    expect(agent.claimResume).toHaveBeenCalledWith('run-1'); // atomic claim — no double drivers
    expect(seenBody.sessionId).toBe('sess-42'); // continues the SAME session
    expect(seenBody.prompt).toContain('The user answered: "blue"');
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'done' }));
    expect(agent.steps.some((s: any) => /resuming/i.test(s.label))).toBe(true);
  });

  it('BEA-1070 replay re-runs a finished run on the SAME input and links back via a step', async () => {
    const agent = fakeAgent();
    agent.runs['old'] = { id: 'old', status: 'failed', input: 'summarise my vendors', title: 'Morning Brief', agentId: null, depth: 'standard', startedAt: '2026-07-24T06:00:00Z' };
    agent.getRun = jest.fn(async (id: string) => agent.runs[id]);
    agent.createRun = jest.fn(async (i: any) => { agent.runs['run-2'] = { id: 'run-2', status: 'running', ...i }; return agent.runs['run-2']; });
    let seenPrompt = '';
    mockCodex((body: any) => { seenPrompt = body.prompt; return { text: 'better this time' }; });
    const res: any = await build(agent).replayRun('old');
    expect(res.id).toBe('run-2');
    await new Promise((r) => setTimeout(r, 25)); // let the fire-and-forget run settle
    expect(agent.createRun).toHaveBeenCalledWith(expect.objectContaining({ input: 'summarise my vendors', title: 'Morning Brief' }));
    expect(seenPrompt).toContain('summarise my vendors'); // the SAME captured input
    expect(agent.steps.some((s: any) => /Replay of an earlier run/.test(s.label))).toBe(true); // linked back
  });

  it('BEA-1070 replay refuses live runs and runs with no kept input', async () => {
    const agent = fakeAgent();
    agent.runs['live'] = { id: 'live', status: 'running', input: 'x' };
    agent.runs['blank'] = { id: 'blank', status: 'done', input: null };
    agent.getRun = jest.fn(async (id: string) => agent.runs[id]);
    const svc = build(agent);
    expect(((await svc.replayRun('live')) as any).ok).toBe(false);
    expect(((await svc.replayRun('blank')) as any).ok).toBe(false);
  });

  it('BEA-1067 guidance: reads never gate, irreversible actions must carry a draft', async () => {
    let seenPrompt = '';
    mockCodex((body: any) => { seenPrompt = body.prompt; return { text: 'ok' }; });
    await build(fakeAgent()).execute('run-1', { prompt: 'task' });
    expect(seenPrompt).toContain('NEVER need permission'); // reads/searches auto-proceed
    expect(seenPrompt).toContain('cannot take back'); // irreversible actions gate
    expect(seenPrompt).toContain('draft'); // …with the exact action shown for approval
  });

  it('BEA-1067 resume translates approve / reject / edited-draft answers into instructions', async () => {
    const mk = (answer: string) => {
      const agent = fakeAgent();
      agent.runs['run-1'] = {
        id: 'run-1', status: 'running', sessionId: 's1', input: 'send the nudge', title: 'T', agentId: null, depth: 'quick',
        waitpoints: [{ id: 'wp-1', status: 'answered', kind: 'approve_edit_reject', question: 'Send this?', answer, answeredAt: '2026-07-24T06:00:00Z' }],
      };
      agent.listResumable = jest.fn(async () => [agent.runs['run-1']]);
      return agent;
    };
    let seen = '';
    mockCodex((body: any) => { seen = body.prompt; return { text: 'done' }; });

    await build(mk('approve')).resumeTick();
    await new Promise((r) => setTimeout(r, 15));
    expect(seen).toContain('APPROVED — go ahead exactly as drafted');

    await build(mk('reject')).resumeTick();
    await new Promise((r) => setTimeout(r, 15));
    expect(seen).toContain('NO — do not do it');

    await build(mk('Hi Jayanth — shorter version')).resumeTick();
    await new Promise((r) => setTimeout(r, 15));
    expect(seen).toContain('EDITED the draft');
    expect(seen).toContain('Hi Jayanth — shorter version');
  });

  it('BEA-795 a park without a session resumes fresh, restating the task', async () => {
    const agent = fakeAgent();
    agent.runs['run-1'] = {
      id: 'run-1', status: 'running', sessionId: '', input: 'summarise my vendors', title: 'T', agentId: null, depth: 'quick',
      waitpoints: [{ id: 'wp-1', status: 'answered', question: 'Include drafts?', answer: 'no', answeredAt: '2026-07-24T06:00:00Z' }],
    };
    agent.listResumable = jest.fn(async () => [agent.runs['run-1']]);
    let seenBody: any = null;
    mockCodex((body: any) => { seenBody = body; return { text: 'done' }; });
    await build(agent).resumeTick();
    await new Promise((r) => setTimeout(r, 20));
    expect(seenBody.sessionId).toBeUndefined(); // no session to continue
    expect(seenBody.prompt).toContain('The task:\nsummarise my vendors'); // restated so the fresh session is self-contained
    expect(agent.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'done' }));
  });
});
