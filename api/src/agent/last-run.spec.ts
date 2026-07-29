import { AgentAreasService } from './agent-areas.service';

/**
 * BEA-1176 — a job's work happens either as a direct agent run OR as a flow run (anything deep, and
 * every voice job, runs as a flow). Looking at only one is why a job that was running right then
 * still showed "never ran" on its agent's page.
 */
function svc(opts: { agentRuns?: any[]; flows?: any[]; flowRuns?: any[] } = {}) {
  const prisma: any = {
    agentArea: { findUnique: async () => ({ id: 'ar1', name: 'Research Agent', tools: '[]', outcome: null }) },
    agent: { findMany: async () => [{ id: 'j1', name: 'Voice job', origin: 'voice' }, { id: 'j2', name: 'Chat job', origin: 'chat' }] },
    agentRun: { findMany: async () => opts.agentRuns || [] },
    flow: { findMany: async () => opts.flows || [] },
    flowRun: { findMany: async () => opts.flowRuns || [] },
  };
  return new AgentAreasService(prisma);
}

describe('a job\'s last run (BEA-1176)', () => {
  it('counts a FLOW run — the voice case that used to read "never ran"', async () => {
    const area = await svc({
      flows: [{ id: 'f1', agentId: 'j1' }],
      flowRuns: [{ flowId: 'f1', status: 'running', startedAt: '2026-07-29T08:00:00Z', endedAt: null }],
    }).get('ar1');
    const j1 = area.jobs.find((j: any) => j.id === 'j1');
    expect(j1.lastRun).toMatchObject({ status: 'running' });
  });

  it('counts a direct agent run, with its grade', async () => {
    const area = await svc({
      agentRuns: [{ agentId: 'j2', status: 'done', startedAt: '2026-07-29T07:00:00Z', endedAt: '2026-07-29T07:05:00Z', grade: JSON.stringify({ verdict: 'pass', score: 90 }) }],
    }).get('ar1');
    const j2 = area.jobs.find((j: any) => j.id === 'j2');
    expect(j2.lastRun.status).toBe('done');
    expect(j2.lastRun.grade).toMatchObject({ verdict: 'pass', score: 90 });
  });

  it('picks whichever happened most recently when a job has both', async () => {
    const area = await svc({
      agentRuns: [{ agentId: 'j1', status: 'done', startedAt: '2026-07-29T06:00:00Z', endedAt: '2026-07-29T06:10:00Z', grade: null }],
      flows: [{ id: 'f1', agentId: 'j1' }],
      flowRuns: [{ flowId: 'f1', status: 'failed', startedAt: '2026-07-29T09:00:00Z', endedAt: '2026-07-29T09:02:00Z' }],
    }).get('ar1');
    expect(area.jobs.find((j: any) => j.id === 'j1').lastRun.status).toBe('failed');
  });

  it('says nothing rather than guessing when a job really has not run', async () => {
    const area = await svc().get('ar1');
    expect(area.jobs.every((j: any) => j.lastRun === null)).toBe(true);
  });

  it('exposes where each job came from', async () => {
    const area = await svc().get('ar1');
    expect(area.jobs.map((j: any) => j.origin).sort()).toEqual(['chat', 'voice']);
  });
});
