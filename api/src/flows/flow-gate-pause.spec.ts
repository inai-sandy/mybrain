import { FlowRunnerService } from './flows-runner.service';
import { ServiceActionsService } from '../tools/service-actions.service';
import { ServiceGatesService } from '../tools/service-gates.service';

/**
 * BEA-1348 — the gate uses the DURABLE pause, not a timeout.
 *
 * A flow step that is about to do something it cannot take back stops, writes the question to the
 * database and ends the walk. Nothing is held in memory: these tests answer the question on a
 * BRAND NEW runner instance, which is exactly what a restart leaves behind.
 */

const DELETE_ACTION = {
  id: 'svc:github.delete_a_repository',
  name: 'Delete a repository',
  description: 'Deletes a repository for good.',
  service: 'github',
  risky: true,
  schema: { type: 'object', required: ['owner', 'repo'], properties: { owner: { type: 'string' }, repo: { type: 'string' } } },
};

const GRAPH = JSON.stringify({
  nodes: [
    { id: 'n1', data: { kind: 'tool', refId: 'svc:github.delete_a_repository', label: 'Delete the old prototype' } },
    { id: 'O', data: { kind: 'output', label: 'Answer' } },
  ],
  edges: [{ source: 'n1', target: 'O' }],
});

/** One world: a flow run row, a ToolCall log, a ServiceGate table, and a stub GitHub. */
function world(gateRows: any[] = []) {
  const flow = { id: 'f1', name: 'Tidy up', graph: GRAPH };
  const row: any = { id: 'r1', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
  const toolCalls: any[] = [];
  const prisma: any = {
    flowRun: {
      findUnique: async () => ({ ...row }),
      update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; },
      updateMany: async ({ data }: any) => { Object.assign(row, data); return { count: 1 }; },
    },
    flow: { findUnique: async () => ({ ...flow }) },
    agentRun: { update: async () => ({}) },
    toolCall: { create: async ({ data }: any) => { toolCalls.push(data); return data; } },
    serviceGate: {
      findFirst: async ({ where }: any) => gateRows.find((r) => Object.entries(where).every(([k, v]) => (v === null ? r[k] == null : r[k] === v))) || null,
      findMany: async () => gateRows,
      create: async ({ data }: any) => { const g = { id: `g${gateRows.length + 1}`, usedAt: null, ...data }; gateRows.push(g); return g; },
      update: async ({ where, data }: any) => { const g = gateRows.find((x) => x.id === where.id); if (g) Object.assign(g, data); return g; },
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const provider: any = {
    getService: async () => ({ slug: 'github', name: 'GitHub', accounts: [{ id: 'ca_1', label: 'sandy on GitHub', status: 'ACTIVE' }] }),
    getAction: async () => DELETE_ACTION,
    execute: jest.fn(async () => ({ ok: true, data: { deleted: true }, ms: 20 })),
    refresh: () => undefined,
  };
  const llm: any = { completeHelper: async () => '{"owner":"inai-sandy","repo":"old-prototype"}' };
  const gates = new ServiceGatesService(prisma, provider);
  const actions = new ServiceActionsService(provider, llm, prisma, gates);

  /** A runner with NOTHING in memory — a fresh process, which is what a restart gives you. */
  const runner = () => {
    const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: async () => undefined };
    const args: any[] = new Array(19).fill({});
    args[0] = prisma; args[3] = { complete: async () => { throw new Error('a gated step must never reach a model'); } };
    args[7] = telegram; args[9] = { send: async () => undefined }; args[10] = { runFailed: async () => undefined }; args[18] = actions;
    const svc = new (FlowRunnerService as any)(...args);
    svc.saveDocuments = async () => [];
    return svc;
  };
  /**
   * `answer()` starts the resumed walk and returns straight away (it is a background driver), so a
   * test has to wait for the run to land rather than assume it already has.
   */
  const settled = async () => {
    for (let i = 0; i < 200 && row.status === 'running'; i++) await new Promise((r) => setImmediate(r));
    return row.status;
  };
  return { flow, row, prisma, provider, toolCalls, gates, runner, gateRows, settled };
}

describe('a step that cannot be undone pauses the run durably (BEA-1348)', () => {
  it('pauses with the real question, and never calls the provider', async () => {
    const w = world();
    await (w.runner() as any).execute('r1', w.flow);

    expect(w.row.status).toBe('waiting');
    expect(w.row.waitNodeId).toBe('n1');
    expect(w.row.waitQuestion).toContain('Delete a repository on GitHub — inai-sandy/old-prototype?');
    expect(w.row.waitQuestion).toContain('This cannot be undone.');
    expect(JSON.parse(w.row.waitOptions)).toEqual(['Yes, run it', 'No, stop']);
    expect(w.provider.execute).not.toHaveBeenCalled();

    // The attempt is on the record before anyone answers.
    expect(w.toolCalls).toHaveLength(1);
    expect(w.toolCalls[0]).toMatchObject({ gated: true, ok: false });

    // And what it is holding was written to the run row, not kept in this process's memory.
    const results = JSON.parse(w.row.results);
    expect(results.n1.status).toBe('waiting');
    expect(results.n1.gate.args).toEqual({ owner: 'inai-sandy', repo: 'old-prototype' });

    // The page is told it is a GATE by a real flag, not by reading the question's words — the card
    // shows a different heading for each, and rewording the question must not flip it.
    const shaped = await w.runner().getRun('r1');
    expect(shaped.waitIsGate).toBe(true);
  });

  it('is still answerable after a restart — a NEW runner runs it once the owner says yes', async () => {
    const w = world();
    await (w.runner() as any).execute('r1', w.flow);
    expect(w.row.status).toBe('waiting');

    // Nothing carried over: a different instance, no memo, no timers. Only the database row.
    const afterRestart = w.runner();
    const res = await afterRestart.answer('r1', 'Yes, run it');
    expect(res.ok).toBe(true);
    await w.settled();

    expect(w.provider.execute).toHaveBeenCalledWith('svc:github.delete_a_repository', { owner: 'inai-sandy', repo: 'old-prototype' }, { connectionId: 'ca_1' });
    expect(w.row.status).toBe('done');
    expect(w.row.waitQuestion).toBeNull();
    // Both rows: the one written when it stopped, and the one for the call that really happened.
    expect(w.toolCalls.map((c) => `${c.gated}:${c.ok}`)).toEqual(['true:false', 'true:true']);
  });

  it('runs nothing when the owner says no, and the run says why', async () => {
    const w = world();
    await (w.runner() as any).execute('r1', w.flow);
    await w.runner().answer('r1', 'No, stop');
    await w.settled();

    expect(w.provider.execute).not.toHaveBeenCalled();
    const results = JSON.parse(w.row.results);
    expect(results.n1.status).toBe('failed');
    expect(results.n1.output).toContain('You said no');
    expect(results.n1.output).toContain('Delete a repository on GitHub — inai-sandy/old-prototype');
    expect(w.row.status).toBe('failed'); // the step it needed did not happen, and the run admits it
  });

  it('does not pause at all once the action is released permanently', async () => {
    const w = world([{ id: 'g0', service: 'github', action: 'svc:github.delete_a_repository', scope: 'always', decision: 'approved', runId: null, nodeId: null }]);
    await (w.runner() as any).execute('r1', w.flow);

    expect(w.row.status).toBe('done');
    expect(w.provider.execute).toHaveBeenCalled();
    expect(w.toolCalls).toHaveLength(1);
    expect(w.toolCalls[0]).toMatchObject({ ok: true, gated: false });
  });
});
