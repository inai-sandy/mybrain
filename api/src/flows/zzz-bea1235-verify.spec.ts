import { FlowRunnerService } from './flows-runner.service';

function harness(overrides: any = {}) {
  const row: any = { id: 'r1x', status: 'running', flowId: 'f1', results: '{}', terminal: '[]', startedAt: new Date() };
  const prisma: any = {
    flowRun: { findUnique: async () => ({ ...row }), update: async ({ data }: any) => { Object.assign(row, data); return { ...row }; }, updateMany: async () => ({ count: 0 }) },
    flow: { findUnique: async () => ({ ...overrides.flowObj }) },
    agentRun: { update: async () => ({}) },
  };
  const llm: any = {
    completeDetailed: async (p: string) => ({ text: null, error: 'boom' }),
    complete: async (p: string) => { overrides.mergePrompts?.push(p); return 'MERGED'; },
  };
  const telegram: any = { notifyFlowWaiting: async () => undefined, notifyFlowDone: async () => undefined };
  const svc = new FlowRunnerService(prisma, {} as any, {} as any, llm, {} as any, {} as any, {} as any, telegram, {} as any);
  (svc as any).saveDocuments = async () => [];
  (svc as any).searchBrain = async (q: string) => { throw new Error('search died: ' + q); };
  return { svc, row };
}

describe('verify hypotheses', () => {
  it('merge with ALL upstream failed: does merge() run?', async () => {
    const mergePrompts: string[] = [];
    const graph = JSON.stringify({
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
    const flowObj = { id: 'f1', name: 'F', graph };
    const { svc, row } = harness({ flowObj, mergePrompts });
    await (svc as any).execute('r1x', flowObj);
    console.log('mergePrompts.length', mergePrompts.length);
    const results = JSON.parse(row.results);
    console.log('M status', results['M']?.status, 'output', results['M']?.output);
    console.log('run status', row.status, 'error', row.error);
  });

  it('ask_user fed only by a dead upstream: does it still pause and ask?', async () => {
    const graph = JSON.stringify({
      nodes: [
        { id: 'r0', data: { kind: 'tool', refId: 'search_brain', label: 'Research', sub: 'q1' } },
        { id: 'B', data: { kind: 'ask_user', question: 'Continue?', label: 'Ask me' } },
        { id: 'O', data: { kind: 'output', label: 'Answer' } },
      ],
      edges: [{ source: 'r0', target: 'B' }, { source: 'B', target: 'O' }],
    });
    const flowObj = { id: 'f1', name: 'F', graph };
    const { svc, row } = harness({ flowObj });
    (svc as any).pauseForInput = async (...args: any[]) => { console.log('pauseForInput CALLED', args[3]); };
    await (svc as any).execute('r1x', flowObj);
    const results = JSON.parse(row.results);
    console.log('B status', results['B']?.status, 'output', results['B']?.output);
    console.log('run status', row.status);
  });
});
