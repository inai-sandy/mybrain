import { RunJournalService, NOT_REPEATABLE, SEED_SEQ } from './run-journal.service';
import { WorkerTokenService, TOKEN_TTL_MS } from './worker-token.service';
import { WorkerTokenGuard } from './worker-token.guard';
import { WORKER_HELPERS, WorkerController } from './worker.controller';
import { fakePrisma, makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';

/**
 * The callback API's own rules (BEA-1387 §C, §H): who may call it, what a token is bound to, and
 * that the journal does each effectful call exactly once and says so loudly when it cannot.
 */

const ctxWith = (headers: any) => ({ switchToHttp: () => ({ getRequest: () => ({ headers, cookies: { mb_session: 'the owner is signed in' } }) }) }) as any;

describe('an owner session must not reach /api/worker/*', () => {
  const build = () => {
    const tokens = new WorkerTokenService(new RunJournalService(fakePrisma()));
    return { tokens, guard: new WorkerTokenGuard(tokens) };
  };

  it('a signed-in browser with no worker token is refused', () => {
    const { guard } = build();
    expect(() => guard.canActivate(ctxWith({}))).toThrow(/worker run/i);
    expect(() => guard.canActivate(ctxWith({ cookie: 'mb_session=abc' }))).toThrow(/worker run/i);
    // the EMO device token is the other owner identity, and it is not a worker either
    expect(() => guard.canActivate(ctxWith({ 'x-device-token': 'emo-device' }))).toThrow(/worker run/i);
  });

  it('a run token gets in, and brings its own identity — the body is never asked', async () => {
    const { tokens, guard } = build();
    const spawn = await tokens.mint('run-1', 'ag1');
    const req: any = { headers: { 'x-worker-token': spawn.token }, body: { runId: 'somebody-elses-run', agentId: 'ag9' } };
    const ok = guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as any);
    expect(ok).toBe(true);
    expect(req.worker).toMatchObject({ runId: 'run-1', agentId: 'ag1' });
    // `Authorization: Bearer` works the same way
    const req2: any = { headers: { authorization: `Bearer ${spawn.token}` } };
    expect(guard.canActivate({ switchToHttp: () => ({ getRequest: () => req2 }) } as any)).toBe(true);
  });

  it('a made-up, revoked or expired token is refused', async () => {
    const { tokens, guard } = build();
    expect(() => guard.canActivate(ctxWith({ 'x-worker-token': 'made-up' }))).toThrow();
    const spawn = await tokens.mint('run-1', 'ag1');
    tokens.revoke(spawn.token);
    expect(() => guard.canActivate(ctxWith({ 'x-worker-token': spawn.token }))).toThrow();
    const short = await tokens.mint('run-2', 'ag1', { ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(tokens.verify(short.token)).toBeNull();
    expect(TOKEN_TTL_MS).toBeLessThanOrEqual(60 * 60_000); // minutes, never the days a question may wait
  });

  it('a token is bound to ONE run: revoking that run kills every token it had', async () => {
    const { tokens } = build();
    const a = await tokens.mint('run-1', 'ag1');
    const b = await tokens.mint('run-1', 'ag1');
    const other = await tokens.mint('run-2', 'ag1');
    expect(tokens.revokeRun('run-1')).toBe(2);
    expect(tokens.verify(a.token)).toBeNull();
    expect(tokens.verify(b.token)).toBeNull();
    expect(tokens.verify(other.token)).toMatchObject({ runId: 'run-2' });
  });

  it('minting marks the run as a worker run, so the Codex sweeper skips it from the first moment', async () => {
    const prisma = fakePrisma();
    const journal = new RunJournalService(prisma);
    const kinds: string[] = [];
    const tokens = new WorkerTokenService(journal, { setRunKind: async (_id: string, k: string) => { kinds.push(k); } } as any);
    await tokens.mint('run-1', 'ag1');
    expect(kinds).toEqual(['worker']);
  });
});

describe('the journal does each call once, and says so when it cannot', () => {
  const build = () => new RunJournalService(fakePrisma());

  it('the first call runs for real, the replay returns the recorded value and does not run', async () => {
    const j = build();
    let ran = 0;
    const work = async () => { ran++; return { rows: 3 }; };
    expect(await j.once('r', 0, 'fetchSource', { a: 1 }, work)).toEqual({ replayed: false, value: { rows: 3 } });
    expect(await j.once('r', 0, 'fetchSource', { a: 1 }, work)).toEqual({ replayed: true, value: { rows: 3 } });
    expect(ran).toBe(1);
  });

  it('a different call at the same position fails loudly and does NOT run', async () => {
    const j = build();
    await j.once('r', 0, 'fetchSource', { a: 1 }, async () => 'first');
    let ran = false;
    await expect(j.once('r', 0, 'writeSheet', { a: 1 }, async () => { ran = true; return 'second'; })).rejects.toThrow(NOT_REPEATABLE);
    // the same function with different arguments is a different call too
    await expect(j.once('r', 0, 'fetchSource', { a: 2 }, async () => 'third')).rejects.toThrow(NOT_REPEATABLE);
    expect(ran).toBe(false);
  });

  it('the same call arriving twice at once is done once — a retry cannot double-spend', async () => {
    const j = build();
    let ran = 0;
    const slow = async () => { ran++; await new Promise((r) => setTimeout(r, 20)); return { credits: 1 }; };
    const both = await Promise.all([j.once('r', 0, 'fetchSource', { a: 1 }, slow), j.once('r', 0, 'fetchSource', { a: 1 }, slow)]);
    expect(ran).toBe(1);
    expect(both.map((b) => b.value)).toEqual([{ credits: 1 }, { credits: 1 }]);
    // a DIFFERENT call at the same position, at the same moment, is still refused
    const clash = j.once('r', 1, 'notify', { to: 'a' }, async () => { await new Promise((r) => setTimeout(r, 20)); return 1; });
    await expect(j.once('r', 1, 'writeSheet', { to: 'b' }, async () => 2)).rejects.toThrow(NOT_REPEATABLE);
    await clash;
  });

  it('the step key reads the arguments as they are — two questions that differ only in a phone number are two calls', async () => {
    const j = build();
    // `argsHashOf()` masks by value shape (a 10-14 digit run becomes •••), which is right for
    // grouping saved answers and would be a silently wrong replay here.
    expect(j.stepKey(0, 'ask', { question: 'Call 98765 43210?' })).not.toEqual(j.stepKey(0, 'ask', { question: 'Call 91234 56789?' }));
    await j.once('r', 0, 'ask', { question: 'Call 98765 43210?' }, async () => 'yes');
    await expect(j.once('r', 0, 'ask', { question: 'Call 91234 56789?' }, async () => 'yes')).rejects.toThrow(NOT_REPEATABLE);
  });

  it('the seed is recorded once per run and replayed for every later spawn', async () => {
    const j = build();
    const first = await j.seed('r');
    await new Promise((r) => setTimeout(r, 5));
    expect(await j.seed('r')).toEqual(first);
    expect((await j.seed('other')).now).toBeGreaterThan(0);
    // it sits outside the worker's own call order, so seq 0 is still the worker's first call
    expect(SEED_SEQ).toBeLessThan(0);
    expect((await j.list('r')).map((x) => x.fn)).toEqual(['seed']);
  });

});

describe('the callback routes', () => {
  it('live under /api/worker — the app adds the /api itself, so the controller must NOT repeat it', () => {
    // `main.ts` calls `setGlobalPrefix('api')`. A controller declared as 'api/worker' answers at
    // /api/api/worker and every worker call 404s — found live, seconds after the first deploy.
    expect(Reflect.getMetadata('path', WorkerController)).toBe('worker');
  });

  const HASHTAG = 'svc:instagram.search_hashtag';
  const SAMPLES: SampleFixture[] = [{ actionId: HASHTAG, args: { hashtag: 'x' }, data: { posts: [{ id: 'p1', url: 'https://instagram.com/p/p1', caption: 'hello' }] } }];
  const job = () => ({ id: 'ag1', name: 'J', prompt: 'Columns id, caption, link.', tools: [HASHTAG], toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'x' } } }, outputDest: 'sheet', mode: 'run' });

  it('a helper a worker may not use is refused before any model is reached', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'r', 'ag1');
    await expect(kit.ai('agent-builder', 'design me something')).rejects.toThrow(/not a helper a worker may use/i);
    expect(world.shaped).toHaveLength(0);
    // `worker-think` joined them (BEA-1453): a worker can now judge — "which of these emails
    // actually matter" — which is the thing it could not do, and the reason a whole agent was
    // routed around the brief, the trial and the gate. The allow-list is still exactly three.
    expect(WORKER_HELPERS).toEqual(['social-shape', 'social-alert', 'worker-think']);
  });

  /**
   * The per-job allow-list is GONE (BEA-1457), and this is where that is written down.
   *
   * BEA-1401 checked every `{actionId,args}` call against `planActionIds ∪ Agent.tools`, on the
   * reasoning that "the worker IS the build, so its reach is the job's reach". In practice that rule
   * is what made a worker brittle: a program that worked out mid-run that it needed one more call
   * could not make it, and every new capability became a hole someone had to cut by hand. Six failed
   * runs in a row, none of them the model's fault, is what settled it.
   *
   * Removing it gives up **nothing that was protecting him**, because none of the real guards ever
   * lived in that list — they live one layer down in `ServiceActionsService` and fire on every call
   * whatever its id. The two tests below prove that on the very call the old list refused.
   */
  it('may call an action that is in neither its plan nor its toolbox (BEA-1457)', async () => {
    const outside = 'svc:instagram.user_posts';
    const world = await makeWorld({
      job: job(), // tools: [HASHTAG] only — `outside` is nowhere on this job
      samples: [...SAMPLES, { actionId: outside, args: { handle: 'a' }, data: { items: [{ id: 'p9' }] } }],
    });
    const { kit } = await spawnKit(world, 'r', 'ag1');

    const out: any = await kit.call(outside, { handle: 'a' });
    expect(out.ok).toBe(true);
    // Wider reach is not anonymity: it is still recorded against this run and this job.
    expect(world.calls.map((c: any) => c.id)).toEqual([outside]);
    expect(world.calls[0].ctx.runKind).toBe('worker');
    expect(world.calls[0].ctx.agentId).toBe('ag1');
  });

  it('but a can’t-undo action still stops and asks him, wherever it came from', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    world.actions.gated.add('svc:github.delete_a_repository');
    const { kit } = await spawnKit(world, 'r', 'ag1');

    // The guard that matters. It never depended on the allow-list, and it does not now: the run
    // parks and the owner is asked, rather than the call being refused or quietly made.
    await expect(kit.call('svc:github.delete_a_repository', { repo: 'notes' })).rejects.toMatchObject({ paused: true });
  });

  it('and the credit ceiling still stops one before it is made', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    world.budget.check = async () => ({ ok: false, reason: 'Today’s Social credit ceiling (500) is reached.', spent: 500, ceiling: 500, estimate: 1 });
    const { kit } = await spawnKit(world, 'r', 'ag1');

    await expect(kit.call('svc:instagram.user_posts', { handle: 'a' })).rejects.toThrow(/credit ceiling/i);
    expect(world.calls).toHaveLength(0); // checked BEFORE the call, so nothing was spent
  });

  it('the fetch stamps progress as it pages, so a slow run is never mistaken for a stuck one', async () => {
    const world = await makeWorld({
      job: { ...job(), toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'x' }, _pages: 2 } } },
      samples: [
        { actionId: HASHTAG, args: { hashtag: 'x' }, data: { posts: [{ id: 'p1' }], cursor: 'c1' } },
        { actionId: HASHTAG, args: { hashtag: 'x', cursor: 'c1' }, data: { posts: [{ id: 'p2' }], cursor: null } },
      ],
    });
    const { kit } = await spawnKit(world, 'r', 'ag1');
    await kit.fetchSource(HASHTAG);
    expect(world.agent.progress.filter((p: string) => /page 1 of 2|page 2 of 2/.test(p))).toHaveLength(2);
    // a worker's own milestone is a checkpoint too — and it is NOT part of the call order
    const before = kit.calls();
    await kit.checkpoint('4 of 9 sources done');
    expect(kit.calls()).toBe(before);
    expect(world.agent.progress[world.agent.progress.length - 1]).toBe('4 of 9 sources done');
  });

  it('finishing the run revokes the spawn\'s token — the worker cannot call again afterwards', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit, spawn } = await spawnKit(world, 'r', 'ag1');
    await kit.finish({ resultText: 'done' });
    expect(world.agent.finished[0]).toMatchObject({ status: 'done', resultText: 'done' });
    expect(world.tokens.verify(spawn.token)).toBeNull();
    await expect(kit.step('one more')).rejects.toThrow(/worker run/i);
  });

  it('finishing drops the run\'s journal — it was only there to make a resume free', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'r', 'ag1');
    await kit.step('one');
    await kit.fetchSource(HASHTAG);
    expect((await world.journal.list('r')).length).toBeGreaterThan(1);
    await kit.finish({ resultText: 'done' });
    expect(await world.journal.list('r')).toEqual([]);
  });

  it('kit.fail ends the run honestly, with the reason on the run', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'r', 'ag1');
    await expect(kit.fail('the vendor changed its answer')).rejects.toThrow('the vendor changed its answer');
    expect(world.agent.finished[0]).toMatchObject({ status: 'failed', error: 'the vendor changed its answer' });
    expect(world.agent.steps.some((s: any) => s.status === 'failed' && /vendor changed/.test(s.label))).toBe(true);
  });
});
