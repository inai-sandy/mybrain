import { UsageService } from './usage.service';

/**
 * BEA-1245 — tokens per research, per agent, and overall.
 *
 * The data always existed (each flow run stores `spend.tokens`; the usage log holds every call);
 * nothing added it up. These lock the two rollups: features() now carries token sums split
 * engine-vs-paid, and agents() rolls flow-run spend up to jobs and agents.
 */

function svc(over: any = {}) {
  const prisma: any = {
    usageLog: {
      findMany: async () => over.usage || [],
      count: async () => (over.usage || []).length,
    },
    agent: { findMany: async () => over.jobs || [] },
    agentArea: { findMany: async () => over.areas || [] },
    flow: { findMany: async () => over.flows || [] },
    flowRun: { findMany: async () => over.runs || [] },
  };
  return new UsageService({ get: async () => null } as any, prisma);
}

describe('overall tokens, engine vs paid (BEA-1245)', () => {
  it('sums tokens separately for engine (included) and paid features', async () => {
    const s = svc({
      usage: [
        { feature: 'agent', cost: null, model: 'codex', promptTokens: 20_000, completionTokens: 3_000 }, // included
        { feature: 'flow-plan', cost: 0.01, model: 'anthropic/claude-sonnet-5', promptTokens: 1_000, completionTokens: 700 },
        { feature: 'flow-plan', cost: 0.01, model: 'anthropic/claude-sonnet-5', promptTokens: 1_200, completionTokens: 800 },
      ],
    });
    const out: any = await s.features(7);
    expect(out.includedTokens).toBe(23_000);
    expect(out.paidTokens).toBe(3_700);
    const fp = out.features.find((f: any) => f.feature === 'flow-plan');
    expect(fp.tokens).toBe(3_700);
  });
});

describe('tokens per job and per agent, from flow runs (BEA-1245)', () => {
  const world = {
    areas: [{ id: 'ar1', name: 'Research Agent', icon: '🔬' }],
    jobs: [
      { id: 'j1', name: 'Meshtastic report', areaId: 'ar1' },
      { id: 'j2', name: 'EV charging report', areaId: 'ar1' },
    ],
    flows: [
      { id: 'f1', agentId: 'j1' },
      { id: 'f2', agentId: 'j2' },
      { id: 'f-unlinked', agentId: 'j-deleted' },
    ],
    runs: [
      { flowId: 'f1', status: 'done', spend: JSON.stringify({ tokens: 40_000, searches: 12, extracts: 5 }) },
      { flowId: 'f1', status: 'failed', spend: JSON.stringify({ tokens: 10_000, searches: 6, extracts: 2 }) },
      { flowId: 'f2', status: 'done', spend: JSON.stringify({ tokens: 25_000, searches: 9, extracts: 4 }) },
      { flowId: 'f2', status: 'done', spend: null }, // a run that spent nothing recorded
      { flowId: 'f1', status: 'done', spend: 'not json' }, // corrupt spend must not sink the rollup
    ],
  };

  it('rolls runs up to jobs, agents and a grand total — failed runs count too, they still spent', async () => {
    const out: any = await svc(world).agents(30);
    const j1 = out.jobs.find((j: any) => j.jobId === 'j1');
    expect(j1).toMatchObject({ job: 'Meshtastic report', agent: 'Research Agent', runs: 3, tokens: 50_000, searches: 18, reads: 7 });
    const j2 = out.jobs.find((j: any) => j.jobId === 'j2');
    expect(j2).toMatchObject({ runs: 2, tokens: 25_000 });
    expect(out.agents).toHaveLength(1); // only agents with runs in the window appear
    const ra = out.agents.find((a: any) => a.agent === 'Research Agent');
    expect(ra).toMatchObject({ runs: 5, tokens: 75_000, searches: 27 });
    expect(out.total.tokens).toBe(75_000);
    // biggest spender first — that is the question the owner is actually asking
    expect(out.jobs[0].jobId).toBe('j1');
  });

  it('a flow whose job was deleted still shows, named honestly, instead of vanishing from the bill', async () => {
    const out: any = await svc({ ...world, runs: [{ flowId: 'f-unlinked', status: 'done', spend: JSON.stringify({ tokens: 5_000, searches: 1, extracts: 0 }) }] }).agents(30);
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0].job).toBe('(deleted job)');
    expect(out.total.tokens).toBe(5_000);
  });

  it('an empty world returns clean zeroes, not a crash', async () => {
    const out: any = await svc({}).agents(30);
    expect(out.total).toEqual({ runs: 0, tokens: 0, searches: 0, reads: 0 });
    expect(out.jobs).toEqual([]);
    expect(out.agents).toEqual([]);
  });
});
