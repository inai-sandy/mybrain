import { FlowRunnerService } from './flows-runner.service';

/**
 * BEA-1192 — a branch does dozens of searches over several minutes and NONE of it reached the flow.
 * The flow logged "started" and then nothing until everything finished, so a healthy five-minute run
 * was indistinguishable from a broken one — which is exactly how one came to be reported as stuck.
 */
function svc(stepLogs: any[][]) {
  let call = 0;
  const prisma: any = {
    agentRun: { findUnique: async () => ({ stepLog: JSON.stringify(stepLogs[Math.min(call++, stepLogs.length - 1)]) }) },
  };
  return new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('a running flow shows what it is doing (BEA-1192)', () => {
  it('mirrors the branch\'s real steps into the flow, and never repeats one', async () => {
    const lines: string[] = [];
    const s: any = svc([
      [{ label: '🌐 Searched: placements 2026' }, { label: '🌐 Searched: COEP stats' }],
      [{ label: '🌐 Searched: placements 2026' }, { label: '🌐 Searched: COEP stats' }, { label: '💬 wrote the answer' }],
    ]);
    const stop = s.mirrorSteps('run-1', (t: string) => lines.push(t));
    await new Promise((r) => setTimeout(r, 4300));
    await new Promise((r) => setTimeout(r, 4300));
    stop();
    expect(lines.some((l) => l.includes('placements 2026'))).toBe(true);
    expect(lines.some((l) => l.includes('wrote the answer'))).toBe(true);
    // each step appears once, however many times it is polled
    expect(lines.filter((l) => l.includes('COEP stats')).length).toBe(1);
  }, 15000);

  it('does nothing at all when there is nowhere to write', () => {
    const s: any = svc([[]]);
    const stop = s.mirrorSteps('run-1', undefined);
    expect(typeof stop).toBe('function');
    stop(); // must not throw
  });

  it('says a branch is waiting when the engine is already busy', async () => {
    const lines: string[] = [];
    const s: any = svc([[]]);
    s.engineQueued = 1; // another branch holds the engine
    s.agent = { createRun: async () => ({ id: 'r1' }), getRun: async () => ({ status: 'done', resultText: 'x' }) };
    s.bridge = { execute: async () => undefined };
    await s.agentRun('p', 'Branch 2', null, (t: string) => lines.push(t));
    expect(lines[0]).toContain('waiting its turn');
    expect(lines.some((l) => l.includes('working'))).toBe(true);
  }, 15000);
});

/**
 * BEA-1194 — the two behaviours that made a 14-minute run produce an empty report.
 */
describe('search is a real call, and thinking fails loudly (BEA-1194)', () => {
  const runner = (web?: any, llm?: any) =>
    new FlowRunnerService({} as any, {} as any, {} as any, llm || {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, web);

  it('a web search calls Tavily — it does NOT spawn an engine turn', async () => {
    let engineUsed = false;
    const web = { search: async () => [{ title: 'T', url: 'https://a', snippet: 's' }], asMarkdown: () => 'Sources found…' };
    const s: any = runner(web);
    s.agentRun = async () => { engineUsed = true; return 'from the engine'; };
    const out = await s.runNode({ data: { kind: 'tool', refId: 'web_search', label: 'Web search' } }, 'placements 2026', []);
    expect(out).toContain('Sources found');
    expect(engineUsed).toBe(false);
  });

  it('a meaning search goes to Exa, not Tavily', async () => {
    let which = '';
    const web = { search: async () => { which = 'tavily'; return []; }, searchByMeaning: async () => { which = 'exa'; return []; }, asMarkdown: () => 'x' };
    const s: any = runner(web);
    await s.runNode({ data: { kind: 'tool', refId: 'web_search_meaning', label: 'Search by meaning' } }, 'what is changing', []);
    expect(which).toBe('exa');
  });

  it('a search failure throws with its reason, so the step is marked failed', async () => {
    const web = { search: async () => { throw new Error('Tavily is out of credits or rate-limited right now.'); } };
    const s: any = runner(web);
    await expect(s.runNode({ data: { kind: 'tool', refId: 'web_search', label: 'Web search' } }, 'q', [])).rejects.toThrow(/out of credits/);
  });

  it('a thinking step that cannot think throws instead of returning nothing', async () => {
    const llm = { completeDetailed: async () => ({ text: null, error: 'qwen/qwen3.7-max returned nothing — it may be rate-limited' }) };
    const s: any = runner(undefined, llm);
    await expect(s.runNode({ data: { kind: 'ask_ai', label: 'Ask AI' } }, 'lots of research material', [])).rejects.toThrow(/rate-limited/);
  });

  it('a thinking step that works still returns its answer', async () => {
    const llm = { completeDetailed: async () => ({ text: 'the written section', error: null }) };
    const s: any = runner(undefined, llm);
    expect(await (runner(undefined, llm) as any).runNode({ data: { kind: 'ask_ai' } }, 'material', [])).toBe('the written section');
  });
});

/**
 * BEA-1196 — deep research is OUR loop on the flat-rate engine, not a paid product and not an engine
 * turn that decides for itself how to research. These pin the wiring: the flow calls the service, the
 * toolbox still gates it, and what it spent comes back so the run can record it.
 */
describe('deep research is our own loop (BEA-1196)', () => {
  const runner = (deep?: any) =>
    new FlowRunnerService({} as any, {} as any, {} as any, {} as any as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, deep);

  const node = { data: { kind: 'tool', refId: 'deep_research', label: 'Deep research' } };

  it('calls the research service and never the engine', async () => {
    let engineUsed = false;
    const deep = { run: async () => ({ report: 'The report\n\n### Sources\n\n1. [A](https://a)', spend: { searches: 4, extracts: 3, sources: 9 } }) };
    const s: any = runner(deep);
    s.agentRun = async () => { engineUsed = true; return 'from the engine'; };
    const out = await s.runNode(node, 'what is changing in fresher hiring', []);
    expect(out).toContain('### Sources');
    expect(engineUsed).toBe(false);
  });

  it('hands back what it spent, so the run can record the real cost', async () => {
    const spent: any[] = [];
    const deep = { run: async () => ({ report: 'r', spend: { searches: 6, extracts: 4, sources: 12 } }) };
    const s: any = runner(deep);
    await s.runNode(node, 'q', [], null, null, undefined, (x: any) => spent.push(x));
    expect(spent).toEqual([{ searches: 6, extracts: 4, sources: 12 }]);
  });

  it('passes the node\'s own limits through as the budget', async () => {
    let got: any = null;
    const deep = { run: async (_q: string, o: any) => { got = o.budget; return { report: 'r', spend: { searches: 1, extracts: 0, sources: 1 } }; } };
    const s: any = runner(deep);
    await s.runNode({ data: { ...node.data, maxSearches: 3, maxReads: 2 } }, 'q', []);
    expect(got).toEqual({ searches: 3, extracts: 2 });
  });

  it('records the spend of a FAILED attempt too, so a retry cannot hide the cost', async () => {
    const spent: any[] = [];
    const boom: any = new Error('the searches found nothing to work from');
    boom.spend = { searches: 5, extracts: 0, sources: 0 };
    const deep = { run: async () => { throw boom; } };
    const s: any = runner(deep);
    await expect(s.runNode(node, 'q', [], null, null, undefined, (x: any) => spent.push(x))).rejects.toThrow(/found nothing/);
    expect(spent).toEqual([{ searches: 5, extracts: 0, sources: 0 }]);
  });

  it('is still gated by the agent toolbox', async () => {
    const deep = { run: async () => { throw new Error('should never be called'); } };
    const s: any = runner(deep);
    const out = await s.runNode(node, 'q', [], new Set(['web_search']));
    expect(out).toMatch(/not in this agent's toolbox/);
  });

  it('says so plainly when research is not available on this server', async () => {
    const s: any = runner(undefined);
    await expect(s.runNode(node, 'q', [])).rejects.toThrow(/not available on this server/);
  });

  it('lets a failure through, so the step is marked failed with the reason', async () => {
    const deep = { run: async () => { throw new Error('the searches found nothing to work from'); } };
    const s: any = runner(deep);
    await expect(s.runNode(node, 'q', [])).rejects.toThrow(/found nothing to work from/);
  });
});
