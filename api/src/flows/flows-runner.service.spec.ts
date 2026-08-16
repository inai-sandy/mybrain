import { FlowRunnerService } from './flows-runner.service';

/**
 * BEA-776: a restart mid-run leaves FlowRun rows 'running' with no live driver, and start()'s
 * no-stacking guard then hands that dead run back forever. onModuleInit must fail those orphans —
 * but must NOT touch 'waiting' rows (they're durable and resume via answer()). cancelRun frees a
 * live run and must stick even if a lingering driver later tries to finish it.
 */
function runnerWithPrisma(prisma: any) {
  return new FlowRunnerService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('FlowRunnerService.reconcileOrphans (BEA-776)', () => {
  it("fails orphaned 'running' runs on boot and leaves 'waiting' runs alone", async () => {
    const updates: any[] = [];
    const prisma = {
      flowRun: {
        findMany: async ({ where }: any) => {
          expect(where).toEqual({ status: 'running' }); // waiting is durable — never selected
          return [{ id: 'r1', terminal: '[]' }, { id: 'r2', terminal: null }];
        },
        update: async (args: any) => { updates.push(args); return {}; },
      },
    };
    const n = await runnerWithPrisma(prisma).reconcileOrphans();
    expect(n).toBe(2);
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.data.status).toBe('failed');
      expect(u.data.error).toMatch(/restart/i);
      expect(u.data.endedAt).toBeInstanceOf(Date);
    }
  });

  it('is a no-op when there are no orphans', async () => {
    const prisma = { flowRun: { findMany: async () => [], update: async () => { throw new Error('should not update'); } } };
    expect(await runnerWithPrisma(prisma).reconcileOrphans()).toBe(0);
  });

  it('BEA-859 boot reconcile retries through a transient DB lock', async () => {
    let calls = 0;
    const svc = runnerWithPrisma({});
    (svc as any).reconcileOrphans = jest.fn(async () => {
      calls++;
      if (calls < 2) throw new Error('database is locked');
      return 1;
    });
    await svc.reconcileWithRetry(5, 1);
    expect(calls).toBe(2);
  });
});

describe('FlowRunnerService.execute — failure propagation (BEA-800)', () => {
  it('marks the run failed (not done/blank) when the only branch fails', async () => {
    let saved: any = null;
    const prisma: any = {
      flowRun: {
        findUnique: async () => ({ id: 'r1', results: '{}', terminal: '[]' }),
        update: async ({ data }: any) => { saved = data; return {}; },
      },
      agentRun: { update: async () => ({}) },
    };
    const bridge: any = { execute: async () => { throw new Error('engine boom'); } };
    const agent: any = { createRun: async () => ({ id: 'ar1' }), getRun: async () => ({ status: 'failed', error: 'engine boom' }) };
    const telegram: any = { notifyFlowDone: async () => undefined };
    const svc = new FlowRunnerService(prisma, bridge, agent, {} as any, {} as any, {} as any, {} as any, telegram, {} as any);

    // one gmail tool node (still an agent-engine tool) that will fail; no output node → it's the terminal
    // (web_search became a direct Tavily call in BEA-1194, so it no longer exercises the engine path)
    const flow = { id: 'f1', name: 'F', graph: JSON.stringify({ nodes: [{ id: 't1', data: { kind: 'tool', refId: 'gmail', label: 'Web' } }], edges: [] }) };
    await (svc as any).execute('r1', flow);

    expect(saved.status).toBe('failed');       // NOT 'done'
    expect(saved.finalOutput).toBeUndefined(); // no blank/error answer promoted
    expect(String(saved.error)).toMatch(/boom/);
  });
});

describe('FlowRunnerService.runForEval — detached from the flow (BEA-797)', () => {
  it('creates the eval run with flowId null so it cannot block or pollute the flow', async () => {
    let createdData: any = null;
    const prisma: any = {
      flowRun: {
        create: async ({ data }: any) => { createdData = data; return { id: 'ev1', ...data }; },
        update: async () => ({}),
        findUnique: async () => ({ status: 'done', finalOutput: 'x' }),
      },
    };
    const flows: any = { planFlow: async () => ({ nodes: [], edges: [] }) };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, flows);
    (svc as any).execute = jest.fn(async () => undefined);
    await (svc as any).runForEval('f1', 'some input');
    expect(createdData.flowId).toBeNull();
  });
});

describe('FlowRunnerService.answer — atomic claim (BEA-791)', () => {
  it('a double-answer starts only ONE driver', async () => {
    const row: any = { id: 'r1', status: 'waiting', waitNodeId: 'n1', results: '{}', flowId: 'f1' };
    const prisma: any = {
      flowRun: {
        findUnique: async () => ({ ...row }),
        // atomic: flip waiting->running only if still waiting
        updateMany: async ({ where, data }: any) => {
          if (where.status === 'waiting' && row.status === 'waiting') { row.status = data.status; return { count: 1 }; }
          return { count: 0 };
        },
        update: async () => ({}),
      },
      flow: { findUnique: async () => ({ id: 'f1', name: 'F', graph: '{}' }) },
    };
    const svc = runnerWithPrisma(prisma);
    (svc as any).execute = jest.fn(async () => undefined); // don't actually run the graph

    const [a, b] = await Promise.all([svc.answer('r1', 'x'), svc.answer('r1', 'y')]);
    const oks = [a, b].filter((r) => r.ok).length;
    expect(oks).toBe(1);                       // exactly one caller won
    expect((svc as any).execute).toHaveBeenCalledTimes(1); // and only one driver started
  });
});

describe('FlowRunnerService — answering early with a sibling branch still running (BEA-792)', () => {
  it('adopts the in-flight sibling (no re-run), and the old driver cannot clobber the answered state', async () => {
    // Graph: tool A (slow engine call) and ask B feed output O. B pauses while A is mid-flight.
    const graph = JSON.stringify({
      nodes: [
        { id: 'A', data: { kind: 'tool', refId: 'gmail', label: 'Research' } },
        { id: 'B', data: { kind: 'ask_user', question: 'Continue?', label: 'Ask me' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'A', target: 'O' }, { source: 'B', target: 'O' }],
    });
    const flowObj = { id: 'f1', name: 'F', graph };

    const row: any = { id: 'r1', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: {
        findUnique: async () => ({ ...row }),
        update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; },
        updateMany: async ({ where, data }: any) => {
          if (where.status === 'waiting' && row.status === 'waiting') { row.status = data.status; return { count: 1 }; }
          return { count: 0 };
        },
      },
      flow: { findUnique: async () => ({ ...flowObj }) },
      agentRun: { update: async () => ({}) },
    };

    // The engine call for A: resolves only when WE say so (it outlives the pause).
    let releaseA!: () => void;
    const engineGate = new Promise<void>((r) => { releaseA = r; });
    const bridge: any = { execute: jest.fn(async () => { await engineGate; }) };
    const agent: any = {
      createRun: jest.fn(async () => ({ id: 'ar1' })),
      getRun: jest.fn(async () => ({ status: 'done', resultText: 'A-result' })),
    };
    const telegram: any = { notifyFlowWaiting: jest.fn(async () => undefined), notifyFlowDone: jest.fn(async () => undefined) };
    const svc = new FlowRunnerService(prisma, bridge, agent, {} as any, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];

    // Old driver: B pauses the run while A's engine call is still in flight.
    await (svc as any).execute('r1', flowObj);
    expect(row.status).toBe('waiting');
    expect(JSON.parse(row.results).A.status).toBe('running'); // sibling genuinely mid-flight
    expect(JSON.parse(row.results).B.status).toBe('waiting');

    // Answer while A is STILL running — the new driver must adopt A, not restart it.
    const res = await svc.answer('r1', 'go ahead');
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(row.status).toBe('running'); // resumed, waiting on the adopted A

    releaseA(); // the engine call finally finishes (this also wakes the OLD driver's continuation)
    await new Promise((r) => setTimeout(r, 25));

    expect(agent.createRun).toHaveBeenCalledTimes(1); // A ran ONCE — adopted, not re-run
    expect(row.status).toBe('done');
    const results = JSON.parse(row.results);
    expect(results.A).toMatchObject({ status: 'done', output: 'A-result' });
    expect(results.B).toMatchObject({ status: 'done', output: 'go ahead' }); // old driver never clobbered the answer
    expect(String(row.finalOutput)).toContain('A-result'); // the output node saw the adopted branch
  });

  it('a paused driver with NO live siblings resumes cleanly (nothing to adopt)', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'B', data: { kind: 'ask_user', question: 'Continue?', label: 'Ask me' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'B', target: 'O' }],
    });
    const flowObj = { id: 'f1', name: 'F', graph };
    const row: any = { id: 'r1', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: {
        findUnique: async () => ({ ...row }),
        update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; },
        updateMany: async ({ where, data }: any) => {
          if (where.status === 'waiting' && row.status === 'waiting') { row.status = data.status; return { count: 1 }; }
          return { count: 0 };
        },
      },
      flow: { findUnique: async () => ({ ...flowObj }) },
    };
    const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: async () => undefined };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];

    await (svc as any).execute('r1', flowObj);
    expect(row.status).toBe('waiting');
    const res = await svc.answer('r1', 'yes');
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 25));
    expect(row.status).toBe('done');
    expect(String(row.finalOutput)).toContain('yes');
  });
});

describe('FlowRunnerService — on-failure paths + retries (BEA-1071)', () => {
  function harness(graph: any, bridgeImpl: any) {
    const row: any = { id: 'r1', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: {
        findUnique: async () => ({ ...row }),
        update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; },
      },
      agentRun: { update: async () => ({}) },
    };
    const agent: any = { createRun: jest.fn(async () => ({ id: 'ar' + Math.random() })), getRun: jest.fn(async () => ({ status: 'failed', error: 'engine boom' })) };
    const telegram: any = { notifyFlowDone: async () => undefined, notifyFlowWaiting: async () => undefined };
    // completeDetailed is what a thinking step uses now — it reports WHY it came back empty
    // instead of returning '' and letting the flow record "done, 0 chars" (BEA-1194).
    const llm: any = {
      complete: jest.fn(async (p: string) => 'AI: ' + p.slice(0, 40)),
      completeDetailed: jest.fn(async (p: string) => ({ text: 'AI: ' + p.slice(0, 40), error: null })),
    };
    const svc = new FlowRunnerService(prisma, bridgeImpl, agent, llm, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];
    return { svc, row, agent };
  }

  it('an ⚠ on-failure edge runs the fallback with the error text — and the run finishes instead of dying', async () => {
    // A (tool, will fail) → O (output, normal edge); A → F (ask_ai fallback, error edge) → O
    const graph = JSON.stringify({
      nodes: [
        { id: 'A', data: { kind: 'tool', refId: 'gmail', label: 'Research' } },
        { id: 'F', data: { kind: 'ask_ai', label: 'Fallback', sub: 'Explain what went wrong in one line.' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [
        { source: 'A', target: 'O' },
        { source: 'A', target: 'F', data: { onError: true } },
        { source: 'F', target: 'O' },
      ],
    });
    const bridge: any = { execute: async () => { throw new Error('engine boom'); } };
    const h = harness(graph, bridge);
    await (h.svc as any).execute('r1', { id: 'f1', name: 'F', graph });
    const results = JSON.parse(h.row.results);
    expect(results.A.status).toBe('failed');
    expect(results.F.status).toBe('done'); // the fallback ran…
    expect(h.row.status).toBe('done'); // …and the run did NOT die
    expect(String(h.row.finalOutput)).toContain('AI:'); // the fallback's answer became the output
  });

  it('the on-failure path is SKIPPED when nothing failed', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'A', data: { kind: 'ask_ai', label: 'Fine', sub: 'say hi' } },
        { id: 'F', data: { kind: 'ask_ai', label: 'Fallback', sub: 'x' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [
        { source: 'A', target: 'O' },
        { source: 'A', target: 'F', data: { onError: true } },
        { source: 'F', target: 'O' },
      ],
    });
    const h = harness(graph, {} as any);
    await (h.svc as any).execute('r1', { id: 'f1', name: 'F', graph });
    const results = JSON.parse(h.row.results);
    expect(results.A.status).toBe('done');
    expect(results.F.status).toBe('skipped'); // fallback never fired
    expect(h.row.status).toBe('done');
  });

  it('retries: a node that fails once then succeeds finishes when retries are allowed', async () => {
    let calls = 0;
    const bridge: any = { execute: async () => { calls++; if (calls === 1) throw new Error('flaky'); } };
    const graph = JSON.stringify({
      nodes: [
        { id: 'A', data: { kind: 'tool', refId: 'gmail', label: 'Flaky', retries: 2 } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'A', target: 'O' }],
    });
    const h = harness(graph, bridge);
    h.agent.getRun = jest.fn(async () => (calls > 1 ? { status: 'done', resultText: 'worked on retry' } : { status: 'failed', error: 'flaky' }));
    await (h.svc as any).execute('r1', { id: 'f1', name: 'F', graph });
    const results = JSON.parse(h.row.results);
    expect(calls).toBeGreaterThan(1); // it retried
    expect(results.A.status).toBe('done');
    expect(h.row.status).toBe('done');
  });
});

describe('FlowRunnerService.applySkip — per-run branch selection (BEA-796)', () => {
  const flow = {
    id: 'f1', name: 'Flow',
    graph: JSON.stringify({
      nodes: [
        { id: 'question', data: { kind: 'question' } },
        { id: 'b0_sq', data: { kind: 'subquestion' } }, { id: 'b0_s0', data: { kind: 'tool' } },
        { id: 'b1_sq', data: { kind: 'subquestion' } }, { id: 'b1_s0', data: { kind: 'tool' } },
        { id: 'merge', data: { kind: 'merge' } },
      ],
      edges: [],
    }),
  };

  it('disables only the skipped branch, and never mutates the saved flow', () => {
    const svc = runnerWithPrisma({});
    const original = flow.graph; // saved graph string
    const out = (svc as any).applySkip(flow, [1]);
    const nodes = JSON.parse(out.graph).nodes as any[];
    const on = (id: string) => nodes.find((n) => n.id === id)?.data?.enabled;
    expect(on('b1_sq')).toBe(false); // skipped branch off
    expect(on('b1_s0')).toBe(false);
    expect(on('b0_sq')).toBeUndefined(); // kept branch untouched (no enabled flag)
    expect(on('question')).toBeUndefined();
    expect(flow.graph).toBe(original); // the saved flow object is NOT mutated
  });

  it('returns the flow unchanged when nothing is skipped', () => {
    const svc = runnerWithPrisma({});
    expect((svc as any).applySkip(flow, [])).toBe(flow);
    expect((svc as any).applySkip(flow, undefined)).toBe(flow);
  });
});

describe('FlowRunnerService.cancelRun (BEA-776)', () => {
  it("cancels a running run and frees the flow", async () => {
    let saved: any = null;
    const prisma = {
      flowRun: {
        findUnique: async () => ({ id: 'r1', status: 'running', terminal: '[]' }),
        update: async (args: any) => { saved = args; return {}; },
      },
    };
    const res = await runnerWithPrisma(prisma).cancelRun('r1');
    expect(res.ok).toBe(true);
    expect(saved.data.status).toBe('cancelled');
    expect(saved.data.endedAt).toBeInstanceOf(Date);
  });

  it("cancels a waiting run too", async () => {
    let saved: any = null;
    const prisma = {
      flowRun: {
        findUnique: async () => ({ id: 'r2', status: 'waiting', terminal: '[]' }),
        update: async (args: any) => { saved = args; return {}; },
      },
    };
    expect((await runnerWithPrisma(prisma).cancelRun('r2')).ok).toBe(true);
    expect(saved.data.status).toBe('cancelled');
  });

  it("does nothing for an already-finished run", async () => {
    const prisma = {
      flowRun: {
        findUnique: async () => ({ id: 'r3', status: 'done', terminal: '[]' }),
        update: async () => { throw new Error('should not update a finished run'); },
      },
    };
    expect((await runnerWithPrisma(prisma).cancelRun('r3')).ok).toBe(false);
  });
});

describe('FlowRunnerService.sweepFlowParts — working-doc retention (BEA-1085)', () => {
  function harness(docs: any[], days?: string) {
    const removed: string[] = [];
    const prisma: any = {
      setting: { findUnique: async () => (days === undefined ? null : { value: days }) },
      document: { findMany: async () => docs },
    };
    const documents: any = { remove: jest.fn(async (id: string) => { removed.push(id); }) };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, {} as any, documents, {} as any, {} as any, {} as any, {} as any);
    return { svc, removed };
  }
  const old = new Date(Date.now() - 40 * 24 * 3600_000);

  it('removes only untouched old parts, by exact id; edited docs survive', async () => {
    const h = harness([
      { id: 'p1', createdAt: old, updatedAt: old }, // untouched part → cleaned
      { id: 'p2', createdAt: old, updatedAt: new Date(old.getTime() + 3600_000) }, // user edited it → KEEP
    ]);
    expect(await h.svc.sweepFlowParts()).toBe(1);
    expect(h.removed).toEqual(['p1']);
  });

  it('0 days = keep everything forever', async () => {
    const h = harness([{ id: 'p1', createdAt: old, updatedAt: old }], '0');
    expect(await h.svc.sweepFlowParts()).toBe(0);
    expect(h.removed).toEqual([]);
  });
});

describe('FlowRunnerService — If / Filter / Wait are real (BEA-1073)', () => {
  function harness(graph: string) {
    const row: any = { id: 'r1', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; } },
    };
    const telegram: any = { notifyFlowDone: async () => undefined, notifyFlowWaiting: async () => undefined };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];
    return { svc, row };
  }

  it('If routes yes down plain edges and no down ⚠ edges', async () => {
    const mk = (text: string) => JSON.stringify({
      nodes: [
        { id: 'S', data: { kind: 'text', text, label: 'Input' } },
        { id: 'I', data: { kind: 'if', label: 'Urgent?', cond: { op: 'contains', value: 'urgent' } } },
        { id: 'Y', data: { kind: 'text', text: 'YES PATH', label: 'Yes' } },
        { id: 'N', data: { kind: 'text', text: 'NO PATH', label: 'No' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [
        { source: 'S', target: 'I' },
        { source: 'I', target: 'Y' },
        { source: 'I', target: 'N', data: { onError: true } }, // the "no" path
        { source: 'Y', target: 'O' },
        { source: 'N', target: 'O' },
      ],
    });
    const yes = harness(mk('this is urgent, deal with it'));
    await (yes.svc as any).execute('r1', { id: 'f1', name: 'F', graph: mk('this is urgent, deal with it') });
    let results = JSON.parse(yes.row.results);
    expect(results.Y.status).toBe('done');
    expect(results.N.status).toBe('skipped'); // the no path never fired
    expect(yes.row.status).toBe('done');

    const no = harness(mk('all calm today'));
    await (no.svc as any).execute('r1', { id: 'f1', name: 'F', graph: mk('all calm today') });
    results = JSON.parse(no.row.results);
    expect(results.N.status).toBe('done'); // the no path fired…
    expect(no.row.status).toBe('done');
  });

  it('Filter keeps only matching lines', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'S', data: { kind: 'text', text: 'urgent: call vendor\nlater: read blog\nurgent: pay bill', label: 'List' } },
        { id: 'F', data: { kind: 'filter', label: 'Urgent only', match: 'urgent' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'S', target: 'F' }, { source: 'F', target: 'O' }],
    });
    const h = harness(graph);
    await (h.svc as any).execute('r1', { id: 'f1', name: 'F', graph });
    expect(h.row.finalOutput).toContain('call vendor');
    expect(h.row.finalOutput).toContain('pay bill');
    expect(h.row.finalOutput).not.toContain('read blog');
  });

  it('Wait genuinely pauses before the next step', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'S', data: { kind: 'text', text: 'hello', label: 'In' } },
        { id: 'W', data: { kind: 'wait', seconds: 1, label: 'Breathe' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'S', target: 'W' }, { source: 'W', target: 'O' }],
    });
    const h = harness(graph);
    const t0 = Date.now();
    await (h.svc as any).execute('r1', { id: 'f1', name: 'F', graph });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950); // it actually waited
    expect(h.row.status).toBe('done');
  });

  it('evalCond speaks plain English correctly', () => {
    const svc = harness('{}').svc;
    expect(svc.evalCond({ op: 'contains', value: 'Mood' }, 'mood: 3 today')).toBe(true);
    expect(svc.evalCond({ op: 'number_lte', value: '5' }, 'mood: 3 today')).toBe(true);
    expect(svc.evalCond({ op: 'number_gte', value: '5' }, 'mood: 3 today')).toBe(false);
    expect(svc.evalCond({ op: 'empty' }, '   ')).toBe(true);
    expect(svc.evalCond(null, 'anything')).toBe(true); // no condition = "did anything arrive?"
  });
});

describe('FlowRunnerService.testToNode — run to here + pins (BEA-1072)', () => {
  it('runs only the feeders, reuses frozen results, and reports input/output', async () => {
    let engineCalls = 0;
    const graph = JSON.stringify({
      nodes: [
        { id: 'R', data: { kind: 'tool', refId: 'gmail', label: 'Research', pin: { output: 'FROZEN RESEARCH RESULT' } } }, // pinned — must NOT re-run
        { id: 'T', data: { kind: 'text', text: '', label: 'Shape it' } }, // the target (pass-through of input)
        { id: 'ELSEWHERE', data: { kind: 'tool', refId: 'gmail', label: 'Unrelated' } }, // NOT upstream — must not run
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'R', target: 'T' }, { source: 'T', target: 'O' }, { source: 'ELSEWHERE', target: 'O' }],
    });
    const prisma: any = { flow: { findUnique: async () => ({ id: 'f1', name: 'F', graph }) } };
    const agent: any = { createRun: jest.fn(async () => { engineCalls++; return { id: 'ar1' }; }), getRun: jest.fn(async () => ({ status: 'done', resultText: 'live result' })) };
    const bridge: any = { execute: jest.fn(async () => { engineCalls++; }) };
    const svc = new FlowRunnerService(prisma, bridge, agent, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svc.testToNode('f1', 'T');
    expect(r.ok).toBe(true);
    expect(r.input).toContain('FROZEN RESEARCH RESULT'); // the pin fed the target…
    expect(engineCalls).toBe(0); // …and nothing expensive ran
    expect(r.nodes!.R.pinned).toBe(true);
    expect(r.nodes!.ELSEWHERE).toBeUndefined(); // untouched — only the feeders ran
  });

  it('the target itself always runs fresh, even if it carries a pin', async () => {
    const graph = JSON.stringify({
      nodes: [{ id: 'T', data: { kind: 'text', text: 'fresh value', label: 'T', pin: { output: 'stale pin' } } }],
      edges: [],
    });
    const prisma: any = { flow: { findUnique: async () => ({ id: 'f1', name: 'F', graph }) } };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const r = await svc.testToNode('f1', 'T');
    expect(r.output).toBe('fresh value'); // not the stale pin
  });
});

/**
 * BEA-1168 — the toolbox is enforced, not advisory: a step whose tool the owner never ticked does
 * not run, and says so instead of returning a blank that reads like it worked.
 */
describe('the toolbox is enforced on a flow step (BEA-1168)', () => {
  const svc = () => new FlowRunnerService({} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  const node = (kind: string, refId: string, label: string) => ({ data: { kind, refId, label } });

  it('refuses a tool that is not in the allowed set, and names it', async () => {
    const out = await (svc() as any).runNode(node('tool', 'gmail', 'Gmail'), 'anything', [], new Set(['web_search']));
    expect(out).toContain('skipped');
    expect(out).toContain('Gmail');
    expect(out).toContain("agent's toolbox");
  });

  it('refuses a skill that is not in the allowed set', async () => {
    const out = await (svc() as any).runNode(node('skill', 'sk9', 'deep-research'), 'x', [], new Set(['web_search']));
    expect(out).toContain('skipped');
    expect(out).toContain('deep-research');
  });

  it('lets an allowed step through to its normal handling', async () => {
    // ask_ai with no input short-circuits to '' — proof it was NOT blocked by the toolbox check.
    const out = await (svc() as any).runNode(node('ask_ai', 'ask_ai', 'Ask AI'), '', [], new Set(['ask_ai']));
    expect(out).toBe('');
  });

  it('blocks nothing when no toolbox has been chosen', async () => {
    const out = await (svc() as any).runNode(node('ask_ai', 'ask_ai', 'Ask AI'), '', [], null);
    expect(out).toBe('');
  });

  /**
   * BEA-1345/1347 — an outside-service step must NEVER come back with an invented answer.
   *
   * An `svc:` id is not in AGENT_TOOLS, so anything that RETURNS instead of throwing falls through
   * to askModel, and for `svc:github.delete_a_repository` a fluent model answer reads as "the repo
   * was deleted" when nothing happened at all. BEA-1345 kept that property with a loud failure
   * because execution did not exist yet; BEA-1347 keeps the same property with execution wired —
   * so this test moved from "not switched on yet" to "with no runner, still fails out loud".
   */
  it('fails an outside-service step out loud when there is no runner, instead of letting the model invent one', async () => {
    const svcId = 'svc:github.delete_a_repository';
    await expect((svc() as any).runNode(node('tool', svcId, 'GitHub: Delete repository'), 'go', [], new Set([svcId])))
      .rejects.toThrow(/github.*not available on this server/i);
  });

  it('never blocks a plain building block, only tools and skills', async () => {
    const out = await (svc() as any).runNode({ data: { kind: 'text', text: 'hello' } }, '', [], new Set(['web_search']));
    expect(out).toBe('hello');
  });
});

/**
 * BEA-1168 — "Run to here" does real work, so it must obey the toolbox too. This guards the exact
 * gap a review caught: the test path calling runNode without the allowed set.
 */
describe('"Run to here" obeys the toolbox (BEA-1168)', () => {
  it('passes the allowed set into every runNode call it makes', async () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'flows-runner.service.ts'), 'utf8');
    const calls = src.match(/this\.runNode\([^)]*\)/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    // Every call site must thread `allowed` — a bare runNode(node, input, live) silently disables
    // enforcement on that path.
    for (const c of calls) expect(c).toContain('allowed');
  });
});

describe('FlowRunnerService — a partly-failed run must never report done (BEA-1234)', () => {
  /**
   * Reproduces the real run 14931ba1: three branches researched, two "Ask AI" steps died, one
   * survived — and the flow reported ✓ done with an answer built from a third of the work.
   */
  const threeBranches = () => JSON.stringify({
    nodes: [
      { id: 'b0', data: { kind: 'ask_ai', label: 'Branch 1', sub: 'Branch 1 research' } },
      { id: 'b1', data: { kind: 'ask_ai', label: 'Branch 2', sub: 'Branch 2 research' } },
      { id: 'b2', data: { kind: 'ask_ai', label: 'Branch 3', sub: 'Branch 3 research' } },
      { id: 'O', data: { kind: 'output', label: 'Answer' } },
    ],
    edges: [{ source: 'b0', target: 'O' }, { source: 'b1', target: 'O' }, { source: 'b2', target: 'O' }],
  });

  function harness(graph: string, completeDetailed: any) {
    const flowObj = { id: 'f1', name: 'Placement report', graph };
    const row: any = { id: 'r1', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; }, updateMany: async () => ({ count: 0 }) },
      flow: { findUnique: async () => ({ ...flowObj }) },
      agentRun: { update: async () => ({}) },
    };
    const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: jest.fn(async () => undefined) };
    const llm: any = { completeDetailed };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, llm, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = jest.fn(async () => [{ id: 'd1' }]);
    return { svc, row, flowObj, telegram };
  }

  it('marks the run FAILED when two of three branches died, even though an answer was produced', async () => {
    const { svc, row, flowObj, telegram } = harness(threeBranches(), async (p: string) =>
      p.includes('Branch 1') ? { text: 'the surviving answer' } : { text: null, error: 'qwen/qwen3.7-max returned nothing' });
    await (svc as any).execute('r1', flowObj);

    expect(row.status).toBe('failed'); // the whole point — it used to be 'done'
    expect(telegram.notifyFlowDone).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
  });

  it('names every failed step in the error, so the owner knows what is missing', async () => {
    const { svc, row, flowObj } = harness(threeBranches(), async (p: string) =>
      p.includes('Branch 1') ? { text: 'ok' } : { text: null, error: 'qwen returned nothing' });
    await (svc as any).execute('r1', flowObj);

    expect(String(row.error)).toContain('Branch 2');
    expect(String(row.error)).toContain('Branch 3');
    expect(String(row.error)).not.toContain('Branch 1'); // the one that worked is not blamed
  });

  it('KEEPS the answer and the documents — a partial run must not throw away what worked', async () => {
    const { svc, row, flowObj } = harness(threeBranches(), async (p: string) =>
      p.includes('Branch 1') ? { text: 'the surviving answer' } : { text: null, error: 'nope' });
    await (svc as any).execute('r1', flowObj);

    expect(String(row.finalOutput)).toContain('the surviving answer');
    expect(JSON.parse(row.documentIds || '[]').length).toBe(1);
    expect((svc as any).saveDocuments).toHaveBeenCalled();
    // and it must SAY the answer is incomplete, not present it as the whole thing
    expect(JSON.stringify(row.terminal)).toContain('incomplete');
  });

  it('still reports done when every step worked', async () => {
    const { svc, row, flowObj } = harness(threeBranches(), async () => ({ text: 'fine' }));
    await (svc as any).execute('r1', flowObj);
    expect(row.status).toBe('done');
  });

  it('does NOT fail the run for a failure the flow deliberately catches with a ⚠ edge', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'A', data: { kind: 'ask_ai', label: 'Try this', sub: 'Try this first' } },
        { id: 'B', data: { kind: 'ask_ai', label: 'Fallback', sub: 'Fallback plan' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'A', target: 'B', data: { onError: true } }, { source: 'B', target: 'O' }],
    });
    const { svc, row, flowObj } = harness(graph, async (p: string) =>
      p.includes('Try this') ? { text: null, error: 'boom' } : { text: 'recovered' });
    await (svc as any).execute('r1', flowObj);
    expect(row.status).toBe('done'); // the author planned for it; recovery is not a failed run
  });

  it('a ⚠ fallback that NEVER RAN does not excuse the failure (dead-end alert node)', async () => {
    // The review's repro: the edge exists on the canvas, but the alert it points at is a dead end,
    // so it is never reached and never lands in results. Excusing the failure on the strength of
    // that edge let two dead branches pass as a healthy run.
    const graph = JSON.stringify({
      nodes: [
        { id: 'b0', data: { kind: 'ask_ai', label: 'Branch 1', sub: 'Branch 1 research' } },
        { id: 'b1', data: { kind: 'ask_ai', label: 'Branch 2', sub: 'Branch 2 research' } },
        { id: 'alert', data: { kind: 'ask_ai', label: 'Alert someone', sub: 'tell them' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [
        { source: 'b0', target: 'O' },
        { source: 'b1', target: 'O' },
        { source: 'b1', target: 'alert', data: { onError: true } }, // dead end — nothing after it
      ],
    });
    const { svc, row, flowObj } = harness(graph, async (p: string) =>
      p.includes('Branch 1') ? { text: 'the surviving answer' } : { text: null, error: 'nope' });
    await (svc as any).execute('r1', flowObj);
    expect(row.status).toBe('failed');
    expect(String(row.error)).toContain('Branch 2');
  });

  it('an EVAL run with a failed branch is failed too — and fires none of the side effects', async () => {
    const { svc, row, flowObj, telegram } = harness(threeBranches(), async (p: string) =>
      p.includes('Branch 1') ? { text: 'partial' } : { text: null, error: 'nope' });
    await (svc as any).execute('r1', flowObj, { evalMode: true });
    expect(row.status).toBe('failed'); // so runForEval retries instead of grading a partial answer
    expect(String(row.error)).toContain('Branch 2');
    // An eval is a test run: it must not save documents into the library or message the owner.
    expect((svc as any).saveDocuments).not.toHaveBeenCalled();
    expect(telegram.notifyFlowDone).not.toHaveBeenCalled();
  });

  it('does not count skipped steps when saying how many of them failed', async () => {
    const { svc, row, flowObj } = harness(threeBranches(), async (p: string) =>
      p.includes('Branch 1') ? { text: 'ok' } : { text: null, error: 'nope' });
    (svc as any).applySkip = (f: any) => f;
    await (svc as any).execute('r1', flowObj);
    // 4 nodes exist (3 branches + output); 2 failed, and the denominator must be steps that RAN.
    expect(String(row.error)).toMatch(/^2 of \d+ steps failed/);
    expect(String(row.error)).not.toContain('of 0 steps');
  });

  it('marks the saved document incomplete, so the caveat travels with the file', async () => {
    const saved: any[] = [];
    const { svc, flowObj } = harness(threeBranches(), async (p: string) =>
      p.includes('Branch 1') ? { text: 'the surviving answer' } : { text: null, error: 'nope' });
    (svc as any).saveDocuments = jest.fn(async (_f: any, _g: any, _i: any, _r: any, out: string, incomplete?: boolean) => {
      saved.push({ out, incomplete });
      return [{ id: 'd1' }];
    });
    await (svc as any).execute('r1', flowObj);
    expect(saved[0].incomplete).toBe(true);
  });
});


describe('FlowRunnerService — a failed branch must not vanish into the merge (BEA-1235)', () => {
  /**
   * The real run's shape: subquestion → deep research → Ask AI → merge, three times over. Two Ask AI
   * steps died. `merge()` did `outputs.filter(Boolean)`, dropped the two empty strings, then
   * `if (parts.length === 1) return parts[0]` handed back the survivor verbatim — so 31,204
   * characters of gathered, paid-for research never reached the report and nothing said so.
   */
  const graph = () => JSON.stringify({
    nodes: [
      { id: 'r0', data: { kind: 'tool', refId: 'search_brain', label: 'Research 1', sub: 'q1' } },
      { id: 'r1', data: { kind: 'tool', refId: 'search_brain', label: 'Research 2', sub: 'q2' } },
      { id: 'a0', data: { kind: 'ask_ai', label: 'Branch 1' } },
      { id: 'a1', data: { kind: 'ask_ai', label: 'Branch 2' } },
      { id: 'M', data: { kind: 'merge', mode: 'ai', label: 'Merge', goal: 'the question' } },
      { id: 'O', data: { kind: 'output', label: 'Answer' } },
    ],
    edges: [
      { source: 'r0', target: 'a0' }, { source: 'r1', target: 'a1' },
      { source: 'a0', target: 'M' }, { source: 'a1', target: 'M' },
      { source: 'M', target: 'O' },
    ],
  });

  function harness(onComplete: (p: string) => string | null) {
    const flowObj = { id: 'f1', name: 'F', graph: graph() };
    const row: any = { id: 'r1x', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; }, updateMany: async () => ({ count: 0 }) },
      flow: { findUnique: async () => ({ ...flowObj }) },
      agentRun: { update: async () => ({}) },
    };
    const mergePrompts: string[] = [];
    // Stubs the route the code ACTUALLY takes now (BEA-1236). It used to stub `llm.complete`, which
    // is how a merge still running on the app default model went unnoticed — the test was watching a
    // door the code no longer used. `complete` is left as a tripwire.
    const llm: any = {
      helperModel: async () => ({ provider: 'codex', model: 'codex' }),
      completeWithModel: async (_cfg: any, p: string, _max: number, purpose: string) => {
        if (purpose === 'flow-merge') { mergePrompts.push(p); return { text: 'MERGED', model: 'codex', provider: 'codex', flatRate: true }; }
        const t = onComplete(p);
        return t === null ? { text: null, error: 'qwen/qwen3.7-max returned nothing' } : { text: t, model: 'codex', provider: 'codex', flatRate: true };
      },
      complete: async () => { throw new Error('the general model must not be used for a flow step'); },
    };
    const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: async () => undefined };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, llm, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];
    (svc as any).searchBrain = async (q: string) => `RESEARCH FINDINGS for ${q}`;
    return { svc, row, flowObj, mergePrompts };
  }

  it('hands the merge the dead branch RAW RESEARCH instead of an empty string', async () => {
    const { svc, flowObj, mergePrompts } = harness((p) => (p.includes('Branch 1') || p.includes('q1') ? 'branch 1 answer' : null));
    await (svc as any).execute('r1x', flowObj);

    expect(mergePrompts.length).toBe(1);
    const sent = mergePrompts[0];
    expect(sent).toContain('RESEARCH FINDINGS for q2'); // the rescued research — this used to be ''
    expect(sent).toContain('RAW RESEARCH');
    expect(sent).toContain('Branch 2');
  });

  it('tells the merge WHY the branch is missing, not just that it is', async () => {
    const { svc, flowObj, mergePrompts } = harness((p) => (p.includes('q1') || p.includes('Branch 1') ? 'ok' : null));
    await (svc as any).execute('r1x', flowObj);
    expect(mergePrompts[0]).toContain('qwen/qwen3.7-max returned nothing');
  });

  it('instructs the merge to say what is missing rather than answer as if all parts arrived', async () => {
    const { svc, flowObj, mergePrompts } = harness((p) => (p.includes('q1') || p.includes('Branch 1') ? 'ok' : null));
    await (svc as any).execute('r1x', flowObj);
    expect(mergePrompts[0]).toMatch(/which part is missing or incomplete/i);
  });

  it('says MISSING when the branch produced nothing at all to rescue', async () => {
    // both the research and the summary die on branch 2 → nothing to walk back to
    const { svc, flowObj, mergePrompts } = harness((p) => (p.includes('Branch 1') || p.includes('q1') ? 'ok' : null));
    (svc as any).searchBrain = async (q: string) => { if (q === 'q2') throw new Error('search died'); return `RESEARCH FINDINGS for ${q}`; };
    await (svc as any).execute('r1x', flowObj);
    expect(mergePrompts[0]).toContain('MISSING');
    expect(mergePrompts[0]).toContain('search died');
  });

  it('leaves a healthy run completely alone — no notes, both real answers', async () => {
    const { svc, flowObj, mergePrompts } = harness(() => 'a real answer');
    await (svc as any).execute('r1x', flowObj);
    // The instruction itself mentions MISSING, so only the PARTS may be inspected here.
    const parts = mergePrompts[0].slice(mergePrompts[0].indexOf('--- Research part 1 ---'));
    expect(parts).not.toContain('MISSING');
    expect(parts).not.toContain('RAW RESEARCH');
    expect(parts.match(/--- Research part \d+ ---/g)?.length).toBe(2);
  });
});

describe('FlowRunnerService — the dead-upstream rule must not break the steps that survive it (BEA-1235 follow-up)', () => {
  function harness(graph: string, onAsk: (p: string) => string | null) {
    const flowObj = { id: 'f1', name: 'F', graph };
    const row: any = { id: 'rz', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; }, updateMany: async () => ({ count: 0 }) },
      flow: { findUnique: async () => ({ ...flowObj }) },
      agentRun: { update: async () => ({}) },
    };
    const mergePrompts: string[] = [];
    const llm: any = {
      helperModel: async () => ({ provider: 'codex', model: 'codex' }),
      completeWithModel: async (_cfg: any, p: string, _max: number, purpose: string) => {
        if (purpose === 'flow-merge') { mergePrompts.push(p); return { text: 'MERGED', model: 'codex', provider: 'codex', flatRate: true }; }
        const t = onAsk(p);
        return t === null ? { text: null, error: 'model returned nothing' } : { text: t, model: 'codex', provider: 'codex', flatRate: true };
      },
      complete: async () => { throw new Error('the general model must not be used for a flow step'); },
    };
    const telegram: any = { notifyFlowWaiting: jest.fn(async () => undefined), notifyFlowDone: async () => undefined };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, llm, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];
    (svc as any).searchBrain = async (q: string) => { if (q.startsWith('dead')) throw new Error('research died'); return `FINDINGS ${q}`; };
    return { svc, row, flowObj, mergePrompts };
  }

  it('STILL ASKS the user when the step before them failed — that is the whole point of asking', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'r', data: { kind: 'tool', refId: 'search_brain', label: 'Research', sub: 'dead-q' } },
        { id: 'q', data: { kind: 'ask_user', question: 'Research failed — carry on?', label: 'Ask me' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'r', target: 'q' }, { source: 'q', target: 'O' }],
    });
    const { svc, row, flowObj } = harness(graph, () => 'x');
    const paused = jest.fn(async () => undefined);
    (svc as any).pauseForInput = paused;
    await (svc as any).execute('rz', flowObj).catch(() => undefined);
    expect(paused).toHaveBeenCalled(); // it used to be marked failed and the run just ended
  });

  it('a merge whose branches ALL died still produces a report saying so — without paying for a model call', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'r0', data: { kind: 'tool', refId: 'search_brain', label: 'Research 1', sub: 'dead-1' } },
        { id: 'r1', data: { kind: 'tool', refId: 'search_brain', label: 'Research 2', sub: 'dead-2' } },
        { id: 'M', data: { kind: 'merge', mode: 'ai', label: 'Merge', goal: 'the question' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'r0', target: 'M' }, { source: 'r1', target: 'M' }, { source: 'M', target: 'O' }],
    });
    const { svc, row, flowObj, mergePrompts } = harness(graph, () => 'x');
    await (svc as any).execute('rz', flowObj);
    const res = JSON.parse(row.results);
    expect(res.M.status).toBe('done');
    expect(res.M.output).toContain('No part of this research produced anything');
    expect(res.M.output).toContain('research died');
    expect(mergePrompts.length).toBe(0); // nothing to synthesise — do not spend an engine turn
  });

  it('blames only the step that really broke, not every step downstream of it', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'r0', data: { kind: 'tool', refId: 'search_brain', label: 'Research 1', sub: 'dead-1' } },
        { id: 'a0', data: { kind: 'ask_ai', label: 'Branch 1' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'r0', target: 'a0' }, { source: 'a0', target: 'O' }],
    });
    const { svc, row, flowObj } = harness(graph, () => 'x');
    await (svc as any).execute('rz', flowObj);
    expect(row.status).toBe('failed');
    expect(String(row.error)).toContain('Research 1');   // the real cause
    expect(String(row.error)).not.toContain('Branch 1'); // knock-on, not to blame
    expect(String(row.error)).not.toContain('Answer');
  });

  it('a CRASHED If is not mistaken for one that steered — the step after it must not run on nothing', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'i', data: { kind: 'if', label: 'Check', cond: 'x' } },
        { id: 'a', data: { kind: 'ask_ai', label: 'After', sub: 'go on' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'i', target: 'a' }, { source: 'a', target: 'O' }],
    });
    const { svc, row, flowObj } = harness(graph, () => 'x');
    (svc as any).evalCond = () => { throw new Error('condition blew up'); };
    await (svc as any).execute('rz', flowObj);
    const res = JSON.parse(row.results);
    expect(res.a.status).toBe('failed');           // it used to run on '' and report done
    expect(res.a.output).toContain('never arrived');
  });
});

describe('FlowRunnerService — thinking steps follow THE engine (BEA-1236)', () => {
  const graph = JSON.stringify({
    nodes: [
      { id: 'a', data: { kind: 'ask_ai', label: 'Think', sub: 'work it out' } },
      { id: 'O', data: { kind: 'output', label: 'Answer' } },
    ],
    edges: [{ source: 'a', target: 'O' }],
  });

  function harness(llm: any) {
    const flowObj = { id: 'f1', name: 'F', graph };
    const row: any = { id: 're', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; }, updateMany: async () => ({ count: 0 }) },
      flow: { findUnique: async () => ({ ...flowObj }) },
      agentRun: { update: async () => ({}) },
    };
    const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: async () => undefined };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, llm, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];
    return { svc, row, flowObj };
  }

  it('asks the ENGINE, never the general model setting', async () => {
    const used: any[] = [];
    const { svc, flowObj } = harness({
      helperModel: async (k: string) => (k === 'flow-node' ? { provider: 'codex', model: 'codex' } : null),
      completeWithModel: async (cfg: any) => { used.push(cfg); return { text: 'thought', model: 'codex', provider: 'codex', flatRate: true }; },
      completeDetailed: async () => { used.push('GENERAL-MODEL'); return { text: 'wrong path', error: null }; },
    });
    await (svc as any).execute('re', flowObj);
    expect(used).toEqual([{ provider: 'codex', model: 'codex' }]);
    expect(used).not.toContain('GENERAL-MODEL'); // the qwen path that killed two branches
  });

  it('SAYS SO when every engine was down and a paid model answered instead', async () => {
    const { svc, row, flowObj } = harness({
      helperModel: async () => ({ provider: 'codex', model: 'codex' }),
      completeWithModel: async () => ({ text: 'thought', model: 'anthropic/claude-sonnet-4.6', provider: 'openrouter', flatRate: false }),
    });
    await (svc as any).execute('re', flowObj);
    expect(JSON.stringify(row.terminal)).toContain('your engine was unavailable');
    expect(JSON.stringify(row.terminal)).toContain('paid');
  });

  it('says nothing extra on the normal path', async () => {
    const { svc, row, flowObj } = harness({
      helperModel: async () => ({ provider: 'codex', model: 'codex' }),
      completeWithModel: async () => ({ text: 'thought', model: 'codex', provider: 'codex', flatRate: true }),
    });
    await (svc as any).execute('re', flowObj);
    expect(JSON.stringify(row.terminal)).not.toContain('unavailable');
  });

  it('fails loudly when the engine cannot answer — no quiet hop to another model', async () => {
    const { svc, row, flowObj } = harness({
      helperModel: async () => ({ provider: 'codex', model: 'codex' }),
      completeWithModel: async () => ({ text: null, error: 'out of quota' }),
    });
    await (svc as any).execute('re', flowObj);
    expect(row.status).toBe('failed');
    expect(String(row.error)).toContain('out of quota');
  });

  it('the MERGE step runs on the engine too — not the general model setting', async () => {
    // The review caught this: registering 'flow-merge' as engine-following and extending askModel's
    // type was not enough. `merge()` still called `llm.complete(prompt, 1600, 'flow-merge')`, where
    // the purpose is a usage LABEL only — so the step that builds the final report from every branch
    // was still on qwen. And a merge failure is quiet: complete() returns null and merge() falls
    // back to joining the parts. Nothing here may reach `complete`.
    const graph2 = JSON.stringify({
      nodes: [
        { id: 'a0', data: { kind: 'ask_ai', label: 'B1', sub: 'one' } },
        { id: 'a1', data: { kind: 'ask_ai', label: 'B2', sub: 'two' } },
        { id: 'M', data: { kind: 'merge', mode: 'ai', label: 'Merge', goal: 'g' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'a0', target: 'M' }, { source: 'a1', target: 'M' }, { source: 'M', target: 'O' }],
    });
    const purposes: string[] = [];
    const flowObj = { id: 'f1', name: 'F', graph: graph2 };
    const row: any = { id: 'rm', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; }, updateMany: async () => ({ count: 0 }) },
      flow: { findUnique: async () => ({ ...flowObj }) },
      agentRun: { update: async () => ({}) },
    };
    const llm: any = {
      helperModel: async (k: string) => { purposes.push(`helper:${k}`); return { provider: 'codex', model: 'codex' }; },
      completeWithModel: async (_c: any, _p: string, max: number, purpose: string) => { purposes.push(`call:${purpose}:${max}`); return { text: 'ok', model: 'codex', provider: 'codex', flatRate: true }; },
      complete: async () => { throw new Error('merge reached the GENERAL model — the bug is back'); },
      completeDetailed: async () => { throw new Error('merge reached the GENERAL model — the bug is back'); },
    };
    const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: async () => undefined };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, llm, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];
    await (svc as any).execute('rm', flowObj);

    expect(row.status).toBe('done');
    expect(purposes).toContain('helper:flow-merge');       // it asked which engine to use
    expect(purposes).toContain('call:flow-merge:1600');    // and called it, keeping the larger budget
  });
});


describe('FlowRunnerService — the flow\'s dates reach EVERY research step (BEA-1238)', () => {
  /**
   * The real graph: three branches, and only `b0_s0` carried `researchFrom`. Branches 2 and 3
   * searched with no limit at all, while branch 1 — starved by the filter — was the one that reached
   * the report and said "cannot be determined".
   */
  const threeResearchers = JSON.stringify({
    researchFrom: '2025-08-01',
    researchTo: '2026-01-31',
    nodes: [
      { id: 'r0', data: { kind: 'tool', refId: 'deep_research', label: 'R1', sub: 'q1' } },
      { id: 'r1', data: { kind: 'tool', refId: 'deep_research', label: 'R2', sub: 'q2' } },
      { id: 'r2', data: { kind: 'tool', refId: 'deep_research', label: 'R3', sub: 'q3', researchFrom: '2020-01-01' } },
      { id: 'O', data: { kind: 'output', label: 'Answer' } },
    ],
    edges: [{ source: 'r0', target: 'O' }, { source: 'r1', target: 'O' }, { source: 'r2', target: 'O' }],
  });

  it('passes the flow dates to every research step, and lets one step override them', async () => {
    const seen: Array<{ from?: string; to?: string }> = [];
    const flowObj = { id: 'f1', name: 'F', graph: threeResearchers };
    const row: any = { id: 'rd', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
    const prisma: any = {
      flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; }, updateMany: async () => ({ count: 0 }) },
      flow: { findUnique: async () => ({ ...flowObj }) },
      agentRun: { update: async () => ({}) },
    };
    const deep: any = { run: async (_q: string, o: any) => { seen.push({ from: o.from, to: o.to }); return { report: 'a report', spend: {} }; } };
    const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: async () => undefined };
    const svc = new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).deep = deep;
    (svc as any).saveDocuments = async () => [];
    await (svc as any).execute('rd', flowObj);

    expect(seen).toHaveLength(3); // every research step ran, not just the one that was clicked
    // Two inherit the flow's dates…
    expect(seen.filter((s) => s.from === '2025-08-01' && s.to === '2026-01-31')).toHaveLength(2);
    // …and the step with its own dates keeps them.
    expect(seen.some((s) => s.from === '2020-01-01')).toBe(true);
    // Nothing may run with NO dates at all when the flow set them — that was the bug.
    expect(seen.every((s) => !!s.from)).toBe(true);
  });
});

/**
 * BEA-1347 — an outside-service step runs DIRECTLY. No engine run, ever.
 *
 * `flows-runner` established in BEA-1203 that deciding what to do next earns an engine turn and
 * doing the thing does not. An engine turn averages 118,000 tokens; creating a GitHub issue is
 * transformation, not a decision. So the `svc:` branch must reach the provider and never
 * `agentRun()` — and when it cannot run, it must FAIL rather than fall through to a model that
 * would describe the issue it did not create.
 */
describe('an outside-service step never starts an engine run (BEA-1347)', () => {
  const ARGS = 19; // prisma … news, serviceActions
  function svc(serviceActions: any, spy: { engine: number; model: number }) {
    const agent: any = { createRun: async () => { spy.engine++; return { id: 'r1' }; }, getRun: async () => ({ status: 'done', resultText: 'INVENTED' }) };
    const bridge: any = { execute: async () => { spy.engine++; } };
    const llm: any = {
      helperModel: async () => { spy.model++; return { provider: 'openrouter', model: 'x' }; },
      completeWithModel: async () => { spy.model++; return { text: 'INVENTED ANSWER' }; },
      completeDetailed: async () => { spy.model++; return { text: 'INVENTED ANSWER', error: null }; },
      complete: async () => { spy.model++; return 'INVENTED ANSWER'; },
    };
    const args: any[] = new Array(ARGS).fill({});
    args[1] = bridge; args[2] = agent; args[3] = llm; args[ARGS - 1] = serviceActions;
    return new (FlowRunnerService as any)(...args);
  }
  const node = (refId: string) => ({ id: 'n1', data: { kind: 'tool', refId, label: 'GitHub: Create an issue', guidance: 'be brief' } });

  it('routes a svc: step to the provider, with the step\'s context, and starts no agent run', async () => {
    const spy = { engine: 0, model: 0 };
    const seen: any[] = [];
    const runner = svc({ run: async (id: string, input: string, ctx: any) => { seen.push({ id, input, ctx }); return 'Ran GitHub: Create an issue.'; } }, spy);
    const out = await (runner as any).runNode(node('svc:github.create_an_issue'), 'file a bug', [], null, 'agent7', undefined, undefined, undefined, undefined, 'run9');

    expect(out).toContain('Ran GitHub');
    expect(spy.engine).toBe(0); // the whole point — no 118,000-token turn to call an API
    expect(spy.model).toBe(0); // and no thinking call in the runner either
    expect(seen[0].id).toBe('svc:github.create_an_issue');
    expect(seen[0].input).toBe('file a bug');
    expect(seen[0].ctx).toMatchObject({ runId: 'run9', runKind: 'flow', agentId: 'agent7', nodeId: 'n1', guidance: 'be brief' });
  });

  it('fails the step with the real reason instead of letting a model describe what it would have done', async () => {
    const spy = { engine: 0, model: 0 };
    const runner = svc({ run: async () => { throw new Error('GitHub could not do that: Not Found'); } }, spy);
    await expect((runner as any).runNode(node('svc:github.create_an_issue'), 'file a bug', [], null))
      .rejects.toThrow(/Not Found/);
    expect(spy.engine).toBe(0);
    expect(spy.model).toBe(0);
  });
});
