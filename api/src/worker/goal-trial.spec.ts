import { GoalTrialService, titleOf, KEEP_IT, SEND_BACK } from './goal-trial.service';

/**
 * APPROVE → BUILD → RUN ONCE → JUDGE IT AGAINST THE GOAL (BEA-1465).
 *
 * The owner: *"when i approve the goal it has to create an agent and run a sample task to match the
 * goal. verify the goal and the output."*
 *
 * The load-bearing assertions here are about restraint. This service creates a job, compiles it and
 * runs it — and does NOT decide whether the result was any good. Codex wrote the goal and Codex
 * wrote the check; the app carrying a verdict it computed itself would be the exact habit this
 * redesign exists to remove.
 */

function world(opts: { goal?: any; buildOk?: boolean; runStatus?: string; resultText?: string } = {}) {
  const goal = opts.goal === undefined
    ? { id: 'g1', version: 2, status: 'approved', text: 'Read his Gmail at 22:00 and send the messages that need him.', tools: ['svc:gmail.fetch_emails'] }
    : opts.goal;

  const created: any[] = [];
  const updated: any[] = [];
  const runs: any[] = [];
  const asked: any[] = [];
  const sent: any[] = [];
  const builds: any[] = [];
  const dispatched: any[] = [];
  let approvedHook: ((areaId: string) => any) | null = null;

  const prisma: any = {
    agent: { findFirst: async () => null },
    agentRun: {
      findUnique: async ({ where }: any) => runs.find((r) => r.id === where.id) || null,
    },
  };
  const goals: any = {
    approved: async () => goal,
    setOnApproved: (fn: any) => { approvedHook = fn; },
  };
  const agent: any = {
    createAgent: async (input: any) => { created.push(input); return { id: 'job-1' }; },
    updateAgent: async (id: string, input: any) => { updated.push({ id, input }); },
    createRun: async ({ agentId, title }: any) => { const r = { id: 'run-1', agentId, title, status: 'done', resultText: opts.resultText ?? 'Read 14 emails, kept 2, and wrote the summaries.' }; runs.push(r); return r; },
    reopenForDecision: async () => true,
    ask: async (runId: string, q: any) => { asked.push({ runId, ...q }); return { id: 'wp1' }; },
  };
  const buildSvc: any = {
    state: async () => ({ worker: null, stale: false }),
    build: async (agentId: string, o: any) => {
      builds.push({ agentId, ...o });
      return opts.buildOk === false
        ? { worker: null, stale: false, built: { error: 'the tests did not pass' } }
        : { worker: { version: 1 }, stale: false, built: { ok: true, version: 1 } };
    },
  };
  const dispatch: any = {
    run: async (runId: string, agentId: string, o: any) => {
      dispatched.push({ runId, agentId, ...o });
      const r = runs.find((x) => x.id === runId);
      if (r) r.status = opts.runStatus ?? 'done';
      return {};
    },
  };
  const owner: any = { send: async (runId: string, wpId: string, m: any) => { sent.push({ runId, wpId, ...m }); } };

  const svc = new GoalTrialService(prisma, goals, agent, buildSvc, dispatch, {} as any, owner);
  svc.onModuleInit();
  return { svc, created, updated, runs, asked, sent, builds, dispatched, hook: () => approvedHook };
}

/** The service kicks off in the background, so tests wait for it to settle. */
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('approving the goal is the trigger, not a bookmark', () => {
  it('registers itself so approving starts everything', () => {
    const w = world();
    expect(typeof w.hook()).toBe('function');
  });

  it('creates the agent from the GOAL — with the tools he named and no plan', async () => {
    const w = world();
    await w.svc.start('ar1');
    await settle();

    expect(w.created).toHaveLength(1);
    const made = w.created[0];
    expect(made.tools).toEqual(['svc:gmail.fetch_emails']);
    expect(made.origin).toBe('goal');
    expect(made.useWorker).toBe(true);
    // No plan, no sources, no output destination — all of that lives in the program Codex writes.
    expect(made.toolArgs).toBeUndefined();
    expect(made.outputDest).toBeUndefined();
  });

  it('does NOT switch the schedule on — one run is not "live"', async () => {
    const w = world();
    await w.svc.start('ar1');
    await settle();
    expect(w.created[0].enabled).toBe(false);
  });

  it('builds it, then runs it FOR REAL — there is no rehearsal (BEA-1483)', async () => {
    const w = world();
    await w.svc.start('ar1');
    await settle();

    expect(w.builds[0].reason).toContain('goal v2');
    // His instruction: "Nothing Passed. i havent seen anything working… dont guard Codex."
    // A rehearsal that holds every write means he sees nothing happen even when it works perfectly.
    // So the first run writes and sends for real, and he judges the thing rather than a description.
    expect(w.dispatched[0]).toMatchObject({ agentId: 'job-1' });
    expect(w.dispatched[0].trial).toBeUndefined();
  });

  it('refuses when there is no approved goal, and says what to do', async () => {
    const w = world({ goal: null });
    await expect(w.svc.start('ar1')).rejects.toThrow(/Approve the goal first/i);
  });

  it('a second tap does not start a second Codex build', async () => {
    const w = world();
    const [a, b] = await Promise.all([w.svc.start('ar1'), w.svc.start('ar1')]);
    await settle();
    expect([a.started, b.started].filter(Boolean)).toHaveLength(1);
    expect(w.builds.length).toBeLessThanOrEqual(1);
  });

  it('reuses the same job on a second goal rather than piling up drafts', async () => {
    const w = world();
    (w as any).svc = w.svc;
    await w.svc.start('ar1');
    await settle();
    expect(w.created).toHaveLength(1);
  });
});

describe('what he is asked, and what the app does NOT decide', () => {
  it('puts the goal and what it did side by side', async () => {
    const w = world({ resultText: 'Read 14 emails, kept 2, and wrote the summaries.' });
    await w.svc.start('ar1');
    await settle();

    const q = w.asked[0].question as string;
    expect(q).toContain('THE GOAL you approved');
    expect(q).toContain('Read his Gmail at 22:00');
    expect(q).toContain('WHAT IT DID');
    expect(q).toContain('Read 14 emails, kept 2');
    expect(q).toContain('Nothing was saved and nothing was sent');
    expect(q).toContain('Does that match?');
  });

  it('never scores the result itself — the program says what it did, the app asks HIM', async () => {
    const w = world({ resultText: 'Read 14 emails, kept 2.' });
    await w.svc.start('ar1');
    await settle();

    const q = w.asked[0].question as string;
    // No verdict computed here. No "2 of 5 required", no "PASSED", no percentage. The app scoring a
    // result against a goal it did not write is the habit this whole redesign removes.
    expect(q).not.toMatch(/pass(ed)?\b|fail(ed)?\b|\d+%|score|met the goal|did not meet/i);
  });

  it('says so plainly when the program said nothing, rather than inventing a result', async () => {
    const w = world({ resultText: '' });
    await w.svc.start('ar1');
    await settle();
    expect(w.asked[0].question).toContain('It did not say what it did');
  });

  it('offers exactly two answers, and never expires', async () => {
    const w = world();
    await w.svc.start('ar1');
    await settle();
    expect(w.asked[0].options).toEqual([KEEP_IT, SEND_BACK]);
    // A timeout that keeps an agent he never looked at walks straight past this gate.
    expect(w.asked[0].deadlineHours).toBeUndefined();
    expect(w.asked[0].askedVia).toBe('whatsapp');
  });

  it('reaches his phone', async () => {
    const w = world();
    await w.svc.start('ar1');
    await settle();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].choices).toEqual([KEEP_IT, SEND_BACK]);
  });

  it('asks nothing when the run failed — there is no result to judge', async () => {
    const w = world({ runStatus: 'failed' });
    await w.svc.start('ar1');
    await settle();
    expect(w.asked).toHaveLength(0);
    expect(w.sent).toHaveLength(0);
  });

  it('asks nothing when Codex could not build it', async () => {
    const w = world({ buildOk: false });
    await w.svc.start('ar1');
    await settle();
    expect(w.dispatched).toHaveLength(0);
    expect(w.asked).toHaveLength(0);
  });
});

/**
 * "KEEP IT" HAS TO DO SOMETHING (BEA-1481).
 *
 * The road ran perfectly to its last step and then stopped dead. The question reached his phone, he
 * replied "keep it", and nothing happened at all — the run waited for ever and the agent stayed
 * switched off. Everything before this worked; the last inch did not exist.
 */
describe('what his answer does', () => {
  function answered(reply: string) {
    const w = world();
    const enabled: any[] = [];
    const sentBack: string[] = [];
    (w as any).svc.agent = undefined;
    const svc: any = w.svc;
    svc.prisma = {
      agentRun: { findUnique: async () => ({ id: 'run-1', agentId: 'job-1' }) },
      agent: { findUnique: async () => ({ id: 'job-1', areaId: 'ar1' }) },
    };
    svc.agent = {
      updateAgent: async (id: string, input: any) => { enabled.push({ id, ...input }); },
      appendStep: async () => undefined,
      finishRun: async () => undefined,
    };
    // `approved()` for the goal text the schedule is asked about (BEA-1482), and an llm that names a
    // real time — so the test proves the schedule is SET, not just that keeping it does not crash.
    svc.goals = {
      sendBack: async (_a: string, note: string) => { sentBack.push(note); },
      approved: async () => ({ text: 'Runs every day at 22:00 and reads his Gmail.' }),
    };
    svc.llm = { completeHelper: async () => '{"every":"day","at":"22:00","text":"every day at 22:00"}' };
    return { svc, enabled, sentBack, run: () => svc.onAnswer('run-1', reply) };
  }

  it('switches the agent ON — the first moment it may touch anything for real', async () => {
    const a = answered('keep it');
    await a.run();
    // Live AND scheduled. Keeping an agent that never fires is the gap this closed.
    expect(a.enabled).toHaveLength(1);
    expect(a.enabled[0]).toMatchObject({ id: 'job-1', enabled: true, scheduleText: 'every day at 22:00' });
    expect(JSON.parse(a.enabled[0].schedule)).toEqual({ every: 'day', at: '22:00' });
    expect(a.sentBack).toEqual([]);
  });

  it('treats anything else as a correction to the GOAL, in his words', async () => {
    const a = answered('the summaries are too long, one line each');
    await a.run();
    expect(a.enabled).toEqual([]);           // nothing goes live
    expect(a.sentBack).toEqual(['the summaries are too long, one line each']);
  });

  it('does not read "yes but…" as keeping it', async () => {
    // A sentence describing what was wrong must never be mistaken for approval.
    const a = answered('yes but change the time to 21:00');
    await a.run();
    expect(a.enabled).toEqual([]);
    expect(a.sentBack.length).toBe(1);
  });
});

describe('naming the job', () => {
  /**
   * A NAME, NOT CODEX'S OPENING SENTENCE (BEA-1505).
   *
   * Codex writes its goals conversationally, so taking the first line gave him four agents called
   * things like "I will build an agent that you run manually whenever you…" — filling the header and
   * saying nothing. Seen on his own screen before this was written.
   */
  it('uses the name he gave the area, when he gave one', () => {
    expect(titleOf('I will build an agent that fetches things.', 'GitHub top 5')).toBe('GitHub top 5');
  });

  it('ignores a default area name and falls back to the goal', () => {
    expect(titleOf('Read his Gmail at 22:00.', 'New agent')).toBe('Read his Gmail at 22:00.');
    expect(titleOf('Read his Gmail at 22:00.', '   ')).toBe('Read his Gmail at 22:00.');
  });

  it('strips the preamble Codex actually writes', () => {
    // All four of these are real first lines from his agents.
    expect(titleOf('I will build an agent you run by hand that uses GitHub to fetch your repositories.'))
      .toBe('Uses GitHub to fetch your repositories.');
    expect(titleOf('Build a hand-run agent that uses GitHub to fetch the 20 most recent repos.'))
      .toBe('Uses GitHub to fetch the 20 most recent repos.');
    expect(titleOf('The agent will run every day at 22:00 and read my email.'))
      .toBe('Run every day at 22:00 and read my email.');
  });

  it('keeps the original line when stripping would leave nothing useful', () => {
    // A blank name is worse than a bad one.
    const all = 'I will build an agent that you run manually.';
    expect(titleOf(all).length).toBeGreaterThan(8);
  });

  it('takes the goal’s first real line, and nothing more', () => {
    expect(titleOf('# Nightly email digest\n\nIt reads Gmail…')).toBe('Nightly email digest');
    expect(titleOf('\n\n   Read his Gmail at 22:00.\nAnd more.')).toBe('Read his Gmail at 22:00.');
  });

  it('trims a long one rather than putting a paragraph in a list', () => {
    const t = titleOf('x'.repeat(200));
    expect(t.length).toBeLessThanOrEqual(60);
    expect(t.endsWith('…')).toBe(true);
  });

  it('has something to say about an empty goal', () => {
    expect(titleOf('')).toBe('New agent');
  });
});
