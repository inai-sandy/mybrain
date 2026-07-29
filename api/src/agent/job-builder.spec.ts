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

describe('the checks the chat writes (BEA-1172)', () => {
  function svcWith(job: any) {
    const settings = new Map<string, string>([['agent.jobBuilder.ar1', JSON.stringify({ log: [], job })]]);
    const created: any[] = [];
    const prisma: any = {
      setting: {
        findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
        upsert: async ({ where, create, update }: any) => { settings.set(where.key, update?.value ?? create?.value); return {}; },
      },
      agentArea: { findUnique: async () => ({ id: 'ar1', name: 'A', tools: '[]' }) },
    };
    const agentSvc: any = { createAgent: async (i: any) => { created.push(i); return { id: 'j1', name: i.name }; }, updateAgent: async () => ({}) };
    return { svc: new AgentAreasService(prisma, agentSvc, {} as any, {} as any, {} as any), created };
  }

  it('carries the checks straight through to the job', async () => {
    const { svc, created } = svcWith({ name: 'x', task: 'y', checks: ['names its sources', 'fits on one page'] });
    await svc.jobBuilderCreate('ar1');
    expect(created[0].evals.map((e: any) => e.input)).toEqual(['names its sources', 'fits on one page']);
  });

  it('lets you edit the checks before it builds', async () => {
    const { svc, created } = svcWith({ name: 'x', task: 'y', checks: ['original'] });
    await svc.jobBuilderCreate('ar1', { checks: ['mine instead', 'and this'] });
    expect(created[0].evals.map((e: any) => e.input)).toEqual(['mine instead', 'and this']);
  });

  it('falls back to the Outcome so a job is never left ungradeable', async () => {
    const { svc, created } = svcWith({ name: 'x', task: 'y', outcome: 'a one-page brief with sources', checks: [] });
    await svc.jobBuilderCreate('ar1');
    expect(created[0].evals.length).toBe(1);
    expect(created[0].evals[0].input).toBe('a one-page brief with sources');
  });

  it('drops blank checks rather than saving empty ones', async () => {
    const { svc, created } = svcWith({ name: 'x', task: 'y', checks: ['  ', 'real one', ''] });
    await svc.jobBuilderCreate('ar1');
    expect(created[0].evals.map((e: any) => e.input)).toEqual(['real one']);
  });
});

/**
 * BEA-1191 — deleting an agent used to leave its half-finished new-job conversation behind. Nothing
 * reads an orphaned one, but each holds up to 40 messages and they accumulate forever. Same shape as
 * the task bugs: cleanup happens in one place and not in the parallel one.
 */
describe('deleting an agent takes its new-job chat with it (BEA-1191)', () => {
  function build() {
    const settings = new Map<string, string>([['agent.jobBuilder.ar1', JSON.stringify({ log: [{ who: 'you', text: 'hi' }], job: null })]]);
    const deletedKeys: string[] = [];
    const prisma: any = {
      agentArea: { findUnique: async () => ({ id: 'ar1', name: 'A' }), delete: async () => ({}) },
      agent: { findMany: async () => [] },
      setting: {
        findUnique: async ({ where }: any) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
        upsert: async () => ({}),
        delete: async ({ where }: any) => { if (!settings.has(where.key)) throw new Error('not found'); settings.delete(where.key); deletedKeys.push(where.key); return {}; },
      },
    };
    return { svc: new AgentAreasService(prisma), settings, deletedKeys };
  }

  it('removes the chat state for that agent', async () => {
    const { svc, settings, deletedKeys } = build();
    await svc.remove('ar1');
    expect(deletedKeys).toEqual(['agent.jobBuilder.ar1']);
    expect(settings.size).toBe(0);
  });

  it('still deletes the agent when there was no chat to clean up', async () => {
    const { svc } = build();
    await svc.remove('ar1');
    await expect(svc.remove('ar1')).resolves.toMatchObject({ ok: true }); // second pass: nothing to delete, no throw
  });
});
