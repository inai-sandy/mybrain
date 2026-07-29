import { AgentAreasService } from './agent-areas.service';

/**
 * BEA-1182 — duplicating an agent copies its SHAPE (identity, toolbox, standing Outcome), not its
 * work. Copying the jobs and their history would be a surprise, not a shortcut.
 */
function svc(areas: any[]) {
  const created: any[] = [];
  const prisma: any = {
    agentArea: {
      findUnique: async ({ where }: any) => areas.find((a) => a.id === where.id) || null,
      findMany: async () => areas,
      create: async ({ data }: any) => { const row = { id: 'new', ...data }; created.push(data); return row; },
    },
  };
  return { svc: new AgentAreasService(prisma), created };
}

describe('duplicate an agent (BEA-1182)', () => {
  const src = { id: 'ar1', name: 'Research Agent', icon: '🔬', color: '#22d3ee', description: 'deep dives', outcome: 'sourced and clear', tools: '[{"id":"web_search","name":"Web search"}]' };

  it('copies identity, toolbox and the standing Outcome', async () => {
    const { svc: s, created } = svc([src]);
    await s.duplicate('ar1');
    expect(created[0]).toMatchObject({ icon: '🔬', color: '#22d3ee', description: 'deep dives', outcome: 'sourced and clear' });
    expect(created[0].tools).toBe(src.tools);
  });

  it('names the copy clearly, and avoids clashing with one that already exists', async () => {
    const { svc: s1, created: c1 } = svc([src]);
    await s1.duplicate('ar1');
    expect(c1[0].name).toBe('Research Agent copy');

    const { svc: s2, created: c2 } = svc([src, { id: 'ar2', name: 'Research Agent copy' }]);
    await s2.duplicate('ar1');
    expect(c2[0].name).toBe('Research Agent copy 2');
  });

  it('does NOT bring the jobs across', async () => {
    const { svc: s } = svc([src]);
    const out: any = await s.duplicate('ar1');
    expect(out.jobs).toEqual([]);
    expect(out.jobCount).toBe(0);
  });

  it('refuses an agent that does not exist', async () => {
    const { svc: s } = svc([]);
    await expect(s.duplicate('nope')).rejects.toThrow(/not found/i);
  });
});
