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
  const llm: any = { completeHelper: async () => JSON.stringify(opts.reply ?? { reply: 'What time of day?', job: null }) };
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

  it('refuses to build a job from the OLD road, and says what to do instead (BEA-1453)', async () => {
    // These three tests used to assert that a `job` proposal created a live job with tools, checks
    // and a schedule. That road is gone. It made a job switched ON with no brief to read and no run
    // to watch, and a third model drew its flow afterwards — which is how his first real agent was
    // built, and why he asked for the old road to go.
    const { svc, created } = build({
      job: { name: 'EV brief', icon: '🔋', task: '1. search\n2. write', outcome: 'one page', checks: ['names its sources'], tools: [{ id: 'web_search' }] },
    });
    await svc.jobBuilderChat('ar1', 'weekly please');
    await expect(svc.jobBuilderCreate('ar1')).rejects.toThrow(/older way of building jobs/i);
    expect(created.length).toBe(0); // nothing was made
  });

  it('refuses plainly when there is nothing to open at all', async () => {
    const { svc, created } = build({ reply: { reply: 'Which cities?' } });
    await svc.jobBuilderChat('ar1', 'research EV rules');
    await expect(svc.jobBuilderCreate('ar1')).rejects.toThrow(/no brief to open yet/i);
    expect(created.length).toBe(0);
  });

  it('keeps each agent\'s half-finished chat separate', async () => {
    const { svc, settings } = build({ job: { name: 'x', task: 'y' } });
    await svc.jobBuilderReset('ar2');
    expect(settings.has('agent.jobBuilder.ar1')).toBe(true);
    expect(settings.has('agent.jobBuilder.ar2')).toBe(true);
  });
});

describe('the checks the chat writes (BEA-1172)', () => {
  /**
   * These tests used to assert that the chat's checks were carried onto a job it created. The job
   * road is gone (BEA-1453) — what a good run looks like now lives in the brief's own "what it
   * worked means" section, in HIS words, and becomes a real contract the run is failed against.
   * `contractFromBrief` and `brief.spec.ts` cover it there.
   *
   * Kept as one test so the old promise is not silently forgotten: nothing may create a job with
   * checks any more, because nothing may create a job at all without a brief and a watched run.
   */
  it('no longer builds a job from checks — that promise moved into the brief (BEA-1453)', async () => {
    const { svc, created } = build({
      job: { name: 'EV brief', task: '1. search', outcome: 'one page, with sources', checks: ['must name its sources'] },
    });
    await svc.jobBuilderChat('ar1', 'weekly please');
    await expect(svc.jobBuilderCreate('ar1', { checks: ['edited check'] })).rejects.toThrow(/older way of building jobs/i);
    expect(created.length).toBe(0);
  });
});

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
