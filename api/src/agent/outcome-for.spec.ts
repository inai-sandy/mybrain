import { AgentService } from './agent.service';

/**
 * BEA-1173 — what a run is graded against. The fallback to the agent's STANDING Outcome is what
 * lets a voice job, created with no setup of its own, still come back with a pass or fail.
 */
function svc(agent: any, area?: any) {
  const prisma: any = {
    agent: { findUnique: async ({ where }: any) => (agent && where.id === agent.id ? agent : null) },
    agentArea: { findUnique: async ({ where }: any) => (area && where.id === area.id ? area : null) },
  };
  return new AgentService(prisma);
}

describe('outcomeFor (BEA-1173)', () => {
  it("uses the job's own Outcome and checks when it has them", async () => {
    const a = { id: 'j1', areaId: 'ar1', rubric: 'one page with sources', evals: JSON.stringify([{ input: 'names its sources' }, { input: 'one page' }]) };
    expect(await svc(a, { id: 'ar1', outcome: 'agent level' }).outcomeFor('j1')).toEqual({
      rubric: 'one page with sources',
      checks: ['names its sources', 'one page'],
    });
  });

  it("falls back to the agent's standing Outcome when the job has none", async () => {
    const a = { id: 'j1', areaId: 'ar1', rubric: null, evals: '[]' };
    const out = await svc(a, { id: 'ar1', outcome: 'clear, sourced, honest about gaps' }).outcomeFor('j1');
    expect(out.rubric).toBe('clear, sourced, honest about gaps');
  });

  it('returns nothing to grade against when neither is set — the run must still finish', async () => {
    const a = { id: 'j1', areaId: 'ar1', rubric: null, evals: '[]' };
    expect(await svc(a, { id: 'ar1', outcome: null }).outcomeFor('j1')).toEqual({ rubric: '', checks: [] });
  });

  it('never throws on broken data or a missing job', async () => {
    const a = { id: 'j1', areaId: 'ar1', rubric: null, evals: 'not json' };
    expect((await svc(a, { id: 'ar1', outcome: 'x' }).outcomeFor('j1')).checks).toEqual([]);
    expect(await svc(a).outcomeFor('nope')).toEqual({ rubric: '', checks: [] });
    expect(await svc(a).outcomeFor(null)).toEqual({ rubric: '', checks: [] });
  });

  it('drops blank checks', async () => {
    const a = { id: 'j1', areaId: null, rubric: 'r', evals: JSON.stringify([{ input: '  ' }, { input: 'real' }]) };
    expect((await svc(a).outcomeFor('j1')).checks).toEqual(['real']);
  });
});
