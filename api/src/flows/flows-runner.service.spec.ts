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

    // one web_search tool node (an agent-engine tool) that will fail; no output node → it's the terminal
    const flow = { id: 'f1', name: 'F', graph: JSON.stringify({ nodes: [{ id: 't1', data: { kind: 'tool', refId: 'web_search', label: 'Web' } }], edges: [] }) };
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
        { id: 'A', data: { kind: 'tool', refId: 'web_search', label: 'Research' } },
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
    const llm: any = { complete: jest.fn(async (p: string) => 'AI: ' + p.slice(0, 40)) };
    const svc = new FlowRunnerService(prisma, bridgeImpl, agent, llm, {} as any, {} as any, {} as any, telegram, {} as any);
    (svc as any).saveDocuments = async () => [];
    return { svc, row, agent };
  }

  it('an ⚠ on-failure edge runs the fallback with the error text — and the run finishes instead of dying', async () => {
    // A (tool, will fail) → O (output, normal edge); A → F (ask_ai fallback, error edge) → O
    const graph = JSON.stringify({
      nodes: [
        { id: 'A', data: { kind: 'tool', refId: 'web_search', label: 'Research' } },
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
        { id: 'A', data: { kind: 'tool', refId: 'web_search', label: 'Flaky', retries: 2 } },
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
