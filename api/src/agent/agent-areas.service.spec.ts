import { AgentAreasService } from './agent-areas.service';

/** Areas backbone (BEA-1095): agent = area, job = the Agent row. These lock the grouping,
 *  the delete guard (history is precious) and the regrouping move. */

function fakePrisma(overrides: any = {}) {
  const areas = overrides.areas ?? [
    { id: 'ar1', name: 'Research Agent', icon: '🔬', color: '#22d3ee', description: null, tools: '[]', sourceUrl: null, createdAt: new Date() },
    { id: 'ar2', name: 'Daily News', icon: '📰', color: null, description: null, tools: '[{"kind":"api","name":"Tavily","status":"needed"}]', sourceUrl: null, createdAt: new Date() },
  ];
  const agents = overrides.agents ?? [
    { id: 'j1', areaId: 'ar1', name: 'OKF research', icon: '📄', color: null, description: null, enabled: true, scheduleText: null, category: null, createdAt: new Date() },
    { id: 'j2', areaId: 'ar2', name: 'Tech news', icon: '💻', color: null, description: null, enabled: true, scheduleText: 'Every day at 07:00', category: null, createdAt: new Date() },
  ];
  const calls: any = { areaDeletes: [] as string[], agentUpdates: [] as any[] };
  return {
    calls,
    prisma: {
      agentArea: {
        findMany: jest.fn(async () => areas),
        findUnique: jest.fn(async ({ where }: any) => areas.find((a: any) => a.id === where.id) || null),
        create: jest.fn(async ({ data }: any) => ({ id: 'ar-new', tools: '[]', createdAt: new Date(), ...data })),
        update: jest.fn(async ({ where, data }: any) => ({ ...areas.find((a: any) => a.id === where.id), ...data })),
        delete: jest.fn(async ({ where }: any) => { calls.areaDeletes.push(where.id); return {}; }),
      },
      agent: {
        findMany: jest.fn(async ({ where }: any = {}) => agents.filter((a: any) => !where?.areaId || a.areaId === where.areaId)),
        findUnique: jest.fn(async ({ where }: any) => agents.find((a: any) => a.id === where.id) || null),
        count: jest.fn(async ({ where }: any) => agents.filter((a: any) => a.areaId === where.areaId).length),
        update: jest.fn(async (args: any) => { calls.agentUpdates.push(args); return {}; }),
      },
      agentRun: { findMany: jest.fn(async () => [{ agentId: 'j2', status: 'done', startedAt: new Date(), endedAt: new Date() }]) },
    },
  };
}

describe('AgentAreasService (BEA-1095)', () => {
  it('lists areas with their jobs grouped and the last run attached', async () => {
    const { prisma } = fakePrisma();
    const out = await new AgentAreasService(prisma as any).list();
    expect(out.length).toBe(2);
    const news = out.find((a: any) => a.name === 'Daily News')!;
    expect(news.jobCount).toBe(1);
    expect(news.jobs[0].name).toBe('Tech news');
    expect(news.jobs[0].lastRun.status).toBe('done');
    expect(news.tools[0]).toEqual({ kind: 'api', name: 'Tavily', status: 'needed' });
  });

  it('refuses to delete an area that still has jobs (history is precious)', async () => {
    const { prisma } = fakePrisma();
    await expect(new AgentAreasService(prisma as any).remove('ar1')).rejects.toThrow(/still has jobs/);
  });

  it('moveJob regroups a job and quietly removes the emptied one-job wrapper area', async () => {
    const { prisma, calls } = fakePrisma();
    // moving j1 (only job of ar1) into ar2 → after the move ar1 has 0 jobs left
    (prisma.agent.count as jest.Mock).mockImplementation(async ({ where }: any) => (where.areaId === 'ar1' ? 0 : 1));
    const r = await new AgentAreasService(prisma as any).moveJob('j1', 'ar2');
    expect(r.ok).toBe(true);
    expect(calls.agentUpdates[0].data.areaId).toBe('ar2');
    expect(calls.areaDeletes).toContain('ar1');
  });

  it('create needs a name and cleans the tools list', async () => {
    const { prisma } = fakePrisma();
    const svc = new AgentAreasService(prisma as any);
    await expect(svc.create({ name: '' })).rejects.toThrow(/needs a name/);
    const a = await svc.create({ name: 'Research Agent', tools: [{ kind: 'bogus' as any, name: 'Tavily' }, { kind: 'skill', name: '' } as any] });
    expect(a.tools).toEqual([{ kind: 'api', name: 'Tavily', status: 'needed' }]); // bogus kind clamped, empty name dropped
  });
});

/** BEA-1103: one-call spec creation — the landing point for the Claude Code skill + chat builder. */
describe('createFromSpec (BEA-1103)', () => {
  const build = () => {
    const { prisma } = fakePrisma({ areas: [], agents: [] });
    (prisma.agentArea.create as jest.Mock).mockImplementation(async ({ data }: any) => ({ id: 'ar-new', tools: data.tools ?? '[]', createdAt: new Date(), ...data }));
    const created: any[] = [];
    const patched: any[] = [];
    const agentSvc: any = {
      createAgent: jest.fn(async (input: any) => { created.push(input); return { id: 'j-' + created.length, name: input.name, areaId: input.areaId }; }),
      updateAgent: jest.fn(async (id: string, patch: any) => { patched.push({ id, patch }); return {}; }),
    };
    const { AgentAreasService } = require('./agent-areas.service');
    return { svc: new (AgentAreasService as any)(prisma, agentSvc), created, patched };
  };

  it('creates the area + all jobs with schedules and per-job settings', async () => {
    const { svc, created, patched } = build();
    const out = await svc.createFromSpec({
      area: { name: 'Daily News', icon: '📰', tools: [{ kind: 'api', name: 'Tavily' }] },
      jobs: [
        { name: 'Tech news', task: 'get tech news', schedule: { every: 'day', at: '07:00' }, scheduleText: 'Every day at 07:00', notifyWhatsApp: true, keepDays: 30, evals: ['a normal day'] },
        { name: 'AI news', task: 'get AI news' },
      ],
    });
    expect(out.ok).toBe(true);
    expect(out.jobs.map((j: any) => j.name)).toEqual(['Tech news', 'AI news']);
    expect(created[0].areaId).toBe('ar-new');
    expect(created[0].schedule).toEqual({ every: 'day', at: '07:00' });
    expect(created[0].evals[0].input).toBe('a normal day');
    expect(patched[0].patch).toEqual({ notifyWhatsApp: true, keepDays: 30 });
  });

  it('refuses partial specs up front', async () => {
    const { svc } = build();
    await expect(svc.createFromSpec({ area: { name: '' }, jobs: [] })).rejects.toThrow(/needs a name/);
    await expect(svc.createFromSpec({ area: { name: 'X' }, jobs: [] })).rejects.toThrow(/at least one job/);
    await expect(svc.createFromSpec({ area: { name: 'X' }, jobs: [{ name: 'j' }] })).rejects.toThrow(/name and a task/);
  });
});
