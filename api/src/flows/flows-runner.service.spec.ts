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
