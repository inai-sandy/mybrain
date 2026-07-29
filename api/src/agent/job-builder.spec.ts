import { AgentAreasService } from './agent-areas.service';

/**
 * BEA-1170 — "New job" is a real conversation now, not a silent form. These lock the two things
 * that matter: it refuses to build until it actually has a job, and what it builds carries the
 * tools and checks that came out of the conversation.
 */
function build(opts: { job?: any; reply?: any } = {}) {
  const settings = new Map<string, string>();
  if (opts.job !== undefined) settings.set('agent.jobBuilder.ar1', JSON.stringify({ log: [], job: opts.job }));
  const created: any[] = [];
  const patched: any[] = [];
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create, update }: any) => { settings.set(where.key, (update?.value ?? create?.value)); return {}; },
    },
    agentArea: { findUnique: async () => ({ id: 'ar1', name: 'Research Agent', tools: '[]' }) },
    agent: { findMany: async () => [] },
  };
  const agentSvc: any = {
    createAgent: async (input: any) => { created.push(input); return { id: 'job1', name: input.name }; },
    updateAgent: async (id: string, patch: any) => { patched.push({ id, patch }); return {}; },
  };
  const llm: any = { completeWithModel: async () => ({ text: JSON.stringify(opts.reply ?? { reply: 'What time of day?', job: null }) }) };
  const prompts: any = { get: async () => 'TPL {{conversation}} {{agent}} {{tools}}' };
  const catalog: any = { catalog: async () => ({ groups: [], tools: [{ id: 'web_search', name: 'Web search', group: 'Web', description: 'web', connected: true, kind: 'tool' }] }) };
  const svc = new AgentAreasService(prisma, agentSvc, llm, prompts, catalog);
  return { svc, created, patched, settings };
}

describe('the new-job chat (BEA-1170)', () => {
  it('refuses to create while it is still interviewing', async () => {
    const { svc } = build({ job: null });
    await expect(svc.jobBuilderCreate('ar1')).rejects.toThrow(/keep chatting/i);
  });

  it('asks a question instead of guessing when it does not have enough yet', async () => {
    const { svc } = build({ reply: { reply: 'Which cities should I cover?', job: null } });
    const out = await svc.jobBuilderChat('ar1', 'research EV rules');
    expect(out.reply).toBe('Which cities should I cover?');
    expect(out.job).toBeNull(); // nothing proposed yet — it is still asking
  });

  it('keeps the proposal once it has one, and remembers the conversation', async () => {
    const { svc, settings } = build({ reply: { reply: "Here's the plan", job: { name: 'EV brief', task: '1. search' } } });
    const out = await svc.jobBuilderChat('ar1', 'weekly please');
    expect(out.job.name).toBe('EV brief');
    const saved = JSON.parse(settings.get('agent.jobBuilder.ar1')!);
    expect(saved.log.length).toBe(2); // your message + its reply, persisted
    expect(saved.job.name).toBe('EV brief');
  });

  it('builds the job with the task, outcome, tools and checks from the conversation', async () => {
    const { svc, created, patched } = build({
      job: {
        name: 'EV brief', icon: '🔋', task: '1. search\n2. write', outcome: 'one page, with sources',
        checks: ['must name its sources', 'must cover the last 12 months'],
        tools: [{ id: 'web_search', why: 'to find the rules' }],
        depth: 'deep', scheduleText: 'every Monday 8am', notifyWhatsApp: true,
      },
    });
    const r = await svc.jobBuilderCreate('ar1');
    expect(r.jobId).toBe('job1');
    expect(created[0].areaId).toBe('ar1');
    expect(created[0].prompt).toContain('1. search');
    expect(created[0].rubric).toBe('one page, with sources');
    expect(created[0].defaultDepth).toBe('deep');
    expect(created[0].evals.map((e: any) => e.input)).toEqual(['must name its sources', 'must cover the last 12 months']);
    expect(patched[0].patch.tools).toEqual(['web_search']);
    expect(patched[0].patch.notifyWhatsApp).toBe(true);
  });

  it("uses the owner's ticked tools over the ones it proposed", async () => {
    const { svc, patched } = build({ job: { name: 'x', task: 'y', tools: [{ id: 'web_search' }] } });
    await svc.jobBuilderCreate('ar1', { tools: ['search_brain', 'save_document'] });
    expect(patched[0].patch.tools).toEqual(['search_brain', 'save_document']);
  });

  it('clears the proposal after building so the next chat starts fresh', async () => {
    const { svc, settings } = build({ job: { name: 'x', task: 'y' } });
    await svc.jobBuilderCreate('ar1');
    expect(JSON.parse(settings.get('agent.jobBuilder.ar1')!).job).toBeNull();
  });

  it('keeps each agent\'s half-finished chat separate', async () => {
    const { svc, settings } = build({ job: { name: 'x', task: 'y' } });
    await svc.jobBuilderReset('ar2');
    expect(settings.has('agent.jobBuilder.ar1')).toBe(true);
    expect(settings.has('agent.jobBuilder.ar2')).toBe(true);
  });
});
