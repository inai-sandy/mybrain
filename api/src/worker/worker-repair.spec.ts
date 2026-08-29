import { ToolSampleService } from '../tools/tool-sample.service';
import { RunJournalService } from './run-journal.service';
import { WorkerBuildService } from './worker-build.service';
import { COUNTED, WorkerRepairService } from './worker-repair.service';
import { MAX_ATTEMPTS } from './repair';
import { SampleFixture, makeWorld, spawnKit } from './worker-harness.testing';

/**
 * The self-heal loop, end to end on the app's side (BEA-1393, agent workers 8/10 — §G).
 *
 * The worker really runs through the REAL callback controller against REAL saved answers, and it
 * really fails the way BEA-1377 failed. Everything after that is the loop: the evidence is kept, the
 * repair is queued, Codex is asked (a scripted runner stands in for the host process, which has its
 * own real-process suite in `worker-runner.spec.ts`), the promotion guard decides, and the owner is
 * told.
 *
 * The claim this file exists to prove, over and over: **a repair loop cannot spend a rupee.** Every
 * test ends by counting the provider calls, and the count is always the one the RUN made — never one
 * more.
 */

const HASHTAG = 'svc:instagram.search_hashtag';
const post = (id: string) => ({ id, caption: `post ${id}`, url: `https://instagram.com/p/${id}`, taken_at: 1_755_000_000 });
const SAMPLES: SampleFixture[] = [{ actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, data: { posts: [post('p1'), post('p2')] } }];

const job = () => ({
  id: 'ag1',
  name: 'Smart Home India',
  prompt: 'Keep the posts as fetched — columns id, caption, link.',
  tools: [HASHTAG],
  toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } } },
  outputDest: 'sheet',
  sheetId: null,
  notifyWhatsApp: false,
  mode: 'run',
  enabled: true,
  pausedReason: null,
});

/** The sentence the kit really fails a BEA-1377 run with — the one the cause is read out of. */
const BROKEN = 'Fetched 90 answers but recognised 0 rows — this is a My Brain bug, not the vendor. Nothing was written: this is not an empty day at the vendor, it is a bug here.';

const matches = (row: any, where: any = {}): boolean =>
  Object.entries(where || {}).every(([k, v]: [string, any]) => {
    if (k === 'NOT') return !matches(row, v);
    if (v && typeof v === 'object' && Array.isArray(v.in)) return v.in.includes(row[k]);
    return row[k] === v;
  });

/** The two tables this loop writes to, in memory, on top of the harness's own fake Prisma. */
function repairPrisma(base: any) {
  const builds: any[] = [];
  const agents: any[] = [];
  const sort = (rows: any[], orderBy: any) => {
    const key = orderBy ? Object.keys(orderBy)[0] : null;
    if (!key) return rows;
    const dir = orderBy[key] === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => (new Date(a[key]).getTime() - new Date(b[key]).getTime()) * dir);
  };
  let clock = 0;
  return {
    ...base,
    builds,
    agents,
    workerBuild: {
      create: async ({ data }: any) => {
        const row = { id: `b${builds.length + 1}`, version: 0, status: 'building', origin: 'build', cause: null, reason: null, planHash: '', kit: '1', tests: null, sampleIds: '[]', sessionId: null, error: null, log: null, startedAt: new Date(1_700_000_000_000 + clock++ * 1000), finishedAt: null, ...data };
        builds.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = builds.find((b) => b.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      findMany: async ({ where, orderBy, take }: any) => sort(builds.filter((b) => matches(b, where)), orderBy).slice(0, take ?? undefined),
      findFirst: async ({ where, orderBy }: any) => sort(builds.filter((b) => matches(b, where)), orderBy)[0] || null,
      count: async ({ where }: any) => builds.filter((b) => matches(b, where)).length,
    },
    agent: { update: async ({ where, data }: any) => { agents.push({ id: where.id, ...data }); return { id: where.id, ...data }; } },
    toolSample: {
      ...base.toolSample,
      findMany: async ({ where }: any) => base.rows.samples.filter((s: any) => matches(s, where)),
    },
  } as any;
}

/** The host runner, scripted. Every call it is asked to make is counted and readable. */
function fakeRunner() {
  const state = {
    builds: [] as any[],
    promotes: [] as any[],
    parities: [] as any[],
    /** One answer per `/build`, in order. */
    script: [] as any[],
    /** What each version produces when it is measured. */
    parityResults: {} as Record<number, any>,
    build: async (input: any) => {
      state.builds.push(input);
      const next = state.script.shift() || { ok: false, error: 'nothing was scripted for this build' };
      return { version: next.version ?? 2, ...next };
    },
    promote: async (input: any) => { state.promotes.push(input); return { ok: true, version: input.version, previous: 'v1' }; },
    parity: async (input: any) => {
      state.parities.push(input);
      const result = state.parityResults[input.version];
      return { ok: true, version: input.version, result: result || { ok: false, error: 'this version produced nothing' } };
    },
  };
  return state;
}

function fakeAlerts() {
  const said: { headline: string; detail: string; path: string }[] = [];
  return { said, workerRepair: async (m: any) => { said.push(m); return { sent: true }; } };
}

/** The per-job lock, as far as this loop can see it: taken, or held by somebody else. */
function fakeLocks(busy = false) {
  const state = { busy, claims: [] as string[], released: [] as string[], renewed: 0 };
  return {
    state,
    claim: async (jobId: string) => { state.claims.push(jobId); return state.busy ? { ok: false, held: { holder: 'someone-else' } } : { ok: true, holder: `h-${jobId}` }; },
    renew: async () => { state.renewed++; return true; },
    release: async (holder: string) => { state.released.push(holder); return true; },
  };
}

async function setUp(opts: { busy?: boolean; samples?: SampleFixture[] } = {}) {
  const world = await makeWorld({ job: job(), samples: opts.samples || SAMPLES });
  const prisma = repairPrisma(world.prisma);
  const store = new ToolSampleService(prisma);
  const journal = new RunJournalService(prisma);
  const runner = fakeRunner();
  const builds = new WorkerBuildService(prisma, world.agent as any, runner as any, undefined, store);
  const alerts = fakeAlerts();
  const locks = fakeLocks(opts.busy);
  const repairs = new WorkerRepairService(prisma, world.agent as any, builds, runner as any, journal, store, locks as any, alerts as any);
  // The job has a worker: v1, live since yesterday.
  await prisma.workerBuild.create({ data: { agentId: 'ag1', version: 1, status: 'promoted', origin: 'build', planHash: 'sha256:aaa', kit: '1', sampleIds: '[]' } });
  return { world, prisma, store, journal, runner, builds, alerts, locks, repairs };
}

/** One real worker run against the saved answers, which then fails the way BEA-1377 failed. */
async function failedRun(world: any, runId = 'run-1') {
  const { kit } = await spawnKit(world, runId, 'ag1');
  await kit.fetchSource(HASHTAG);
  return runId;
}

describe('self-heal: keeping the answer that broke it (BEA-1393)', () => {
  it('keeps every source\'s answer with the error and the contract, and queues one repair', async () => {
    const w = await setUp();
    const runId = await failedRun(w.world);
    const vendorCalls = w.world.calls.length;

    await w.repairs.onRunFailed(runId, { agentId: 'ag1', error: BROKEN, runKind: 'worker' });

    const kept = w.prisma.rows.samples.filter((s: any) => s.kind === 'failing');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ actionId: HASHTAG, agentId: 'ag1', kind: 'failing' });
    expect(kept[0].note).toMatch(/kept as evidence/);
    const bundle = JSON.parse((await require('util').promisify(require('zlib').gunzip)(kept[0].payload)).toString('utf8'));
    expect(bundle.failedWith).toBe(BROKEN);
    expect(bundle.rule).toBe('unrecognised');
    expect(bundle.contract).toMatchObject({ minRows: 1, allowEmptyWhen: 'every source returned an empty answer' });
    // The answer the WORKER really saw, not a story about it.
    expect(bundle.answer.table.rows).toHaveLength(2);

    const queued = w.prisma.builds.filter((b: any) => b.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ origin: 'repair', cause: `ag1|unrecognised|${HASHTAG}`, reason: BROKEN });
    expect(JSON.parse(queued[0].sampleIds)).toHaveLength(1);
    // Nothing has been asked of Codex yet, and nothing of a vendor.
    expect(w.runner.builds).toHaveLength(0);
    expect(w.world.calls).toHaveLength(vendorCalls);
  });

  it('a job with no worker of its own is left alone — there is nothing to repair', async () => {
    const w = await setUp();
    w.prisma.builds.length = 0; // no promoted version
    const runId = await failedRun(w.world);
    await w.repairs.onRunFailed(runId, { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    expect(w.prisma.builds).toHaveLength(0);
    // …but the evidence is still kept: the answer is worth having whichever road the job is on.
    expect(w.prisma.rows.samples.filter((s: any) => s.kind === 'failing')).toHaveLength(1);
  });

  it('one repair per cause at a time, and a second failure of the same cause does not queue another', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-1'), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-2'), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    expect(w.prisma.builds.filter((b: any) => b.status === 'queued')).toHaveLength(1);
  });
});

describe('self-heal: the repair turn (BEA-1393)', () => {
  it('repairs, measures, promotes — starting from the version that broke and spending nothing', async () => {
    const w = await setUp();
    const runId = await failedRun(w.world);
    const vendorCalls = w.world.calls.length;
    await w.repairs.onRunFailed(runId, { agentId: 'ag1', error: BROKEN, runKind: 'worker' });

    w.runner.script = [{ ok: true, version: 2, wrote: true, tests: { passed: 4, failed: 0 }, sessionId: 'sess-1', log: 'green' }];
    w.runner.parityResults = {
      1: { ok: false, error: 'the field moved' }, // the live worker is what is broken
      2: { ok: true, rows: 2, columns: ['id', 'caption', 'link'], rowKeys: ['a', 'b'] },
    };

    const out = await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    expect(out).toMatchObject({ outcome: 'promoted', version: 2 });

    // ONE fresh Codex session, in a new folder, starting from the live version's own files.
    expect(w.runner.builds).toHaveLength(1);
    expect(w.runner.builds[0]).toMatchObject({ jobId: 'ag1', copyFrom: 1 });
    expect(w.runner.builds[0].brief).toMatch(/Repair the worker/);
    expect(w.runner.builds[0].files['samples/failing.json']).toMatch(/failedWith/);
    // Both versions were measured on the same fixtures, and no kit travelled with them.
    expect(w.runner.parities.map((p: any) => p.version)).toEqual([1, 2]);
    expect(Object.keys(w.runner.parities[0].files).sort()).toEqual(Object.keys(w.runner.parities[1].files).sort());
    expect(Object.keys(w.runner.parities[0].files).some((f) => f.startsWith('kit/'))).toBe(false);
    // Only then does anything go live.
    expect(w.runner.promotes).toEqual([expect.objectContaining({ jobId: 'ag1', version: 2 })]);
    expect(w.runner.promotes[0].meta).toMatchObject({ origin: 'repair', repairedFrom: 1, cause: `ag1|unrecognised|${HASHTAG}` });
    expect(w.prisma.builds.find((b: any) => b.version === 2)).toMatchObject({ status: 'promoted', origin: 'repair', error: null });
    expect(w.alerts.said[0].headline).toMatch(/fixed itself/);
    // The lock was taken and given back, and the whole loop cost nothing at a vendor.
    expect(w.locks.state.claims).toEqual(['ag1']);
    expect(w.locks.state.released).toEqual(['h-ag1']);
    expect(w.world.calls).toHaveLength(vendorCalls);
  });

  it('a repair that changes the rows is HELD for the owner, and the old worker stays live', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [{ ok: true, version: 2, wrote: true, tests: { passed: 4, failed: 0 }, log: 'green' }];
    w.runner.parityResults = {
      1: { ok: true, rows: 10, columns: ['id', 'link'], rowKeys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
      2: { ok: true, rows: 5, columns: ['id', 'link'], rowKeys: ['a', 'b', 'c', 'd', 'e'] },
    };

    const out = await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    expect(out.outcome).toBe('held');
    expect(w.runner.promotes).toHaveLength(0); // nothing went live
    const row = w.prisma.builds.find((b: any) => b.version === 2);
    expect(row.status).toBe('held');
    expect(row.error).toMatch(/Not put live/);
    expect(row.error).toMatch(/v1 is still the live worker/);
    expect(w.alerts.said[0].headline).toMatch(/changes what you get/);
    expect(w.alerts.said[0].detail).toMatch(/it is NOT live/);

    // …and the owner's own decision is the only way it goes live.
    const state = await w.builds.state('ag1');
    expect(state.held).toMatchObject({ version: 2, status: 'held' });
    expect(state.worker).toMatchObject({ version: 1 });
    expect(await w.repairs.accept('ag1', row.id)).toMatchObject({ ok: true, version: 2 });
    expect(w.runner.promotes).toHaveLength(1);
    expect(w.prisma.builds.find((b: any) => b.version === 2).status).toBe('promoted');
    expect(await w.repairs.accept('ag1', row.id)).toMatchObject({ ok: false });
  });

  it('a repair that cannot be measured is held too — a green tick is not a measurement', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [{ ok: true, version: 2, wrote: true, tests: { passed: 4, failed: 0 } }];
    w.runner.parityResults = { 1: { ok: true, rows: 2, columns: ['id'], rowKeys: ['a', 'b'] } }; // v2 answers nothing
    const out = await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    expect(out.outcome).toBe('held');
    expect(w.runner.promotes).toHaveLength(0);
  });

  it('declining leaves the worker exactly as it was', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [{ ok: true, version: 2, wrote: true, tests: { passed: 1, failed: 0 } }];
    w.runner.parityResults = { 1: { ok: true, rows: 2, columns: ['id'], rowKeys: ['a', 'b'] }, 2: { ok: true, rows: 9, columns: ['id'], rowKeys: ['x'] } };
    await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    const held = w.prisma.builds.find((b: any) => b.status === 'held');
    expect(await w.repairs.decline('ag1', held.id)).toEqual({ ok: true });
    expect(w.runner.promotes).toHaveLength(0);
    expect((await w.builds.state('ag1')).worker).toMatchObject({ version: 1 });
  });

  it('never while a run of that job is in flight — the row stays queued and nothing is built', async () => {
    const w = await setUp({ busy: true });
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    const queued = w.prisma.builds.find((b: any) => b.status === 'queued');
    expect(await w.repairs.repair(queued)).toEqual({ outcome: 'busy' });
    expect(w.runner.builds).toHaveLength(0);
    expect(queued.status).toBe('queued'); // the next tick will try again
  });
});

/** Poll until a fact becomes true — for the repairs `tick()` starts without awaiting. */
async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('the condition never came true');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('self-heal: a refusal before Codex is not an attempt (BEA-1577)', () => {
  it('the runner answering busy after the app lock was claimed uses NO attempt — the cause stays queued and a later tick repairs it with both tries intact', async () => {
    // The 2026-08-28 incident: the app-side lock was claimable, the runner\'s own live-map said
    // "This job is busy here (run)" — twice — and the job was paused after "2 failed repairs" in
    // which Codex was never asked anything.
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    const queued = w.prisma.builds.find((b: any) => b.status === 'queued');
    w.runner.script = [{ ok: false, error: 'This job is busy here (run) — try again when it settles.', notStarted: true }];

    const out = await w.repairs.repair(queued);
    expect(out.outcome).toBe('busy');
    expect(w.runner.builds).toHaveLength(1); // it did ask, and was refused at the door
    expect(queued.status).toBe('queued'); // …and nothing was counted: the row went back to the queue
    expect(queued.error).toMatch(/no repair attempt was used/);
    expect(w.prisma.builds.filter((b: any) => b.origin === 'repair' && COUNTED.includes(b.status))).toHaveLength(0);
    expect(w.prisma.agents).toHaveLength(0); // the job is NOT paused
    expect(w.locks.state.released).toEqual(['h-ag1']); // the app lock was given back

    // A later tick finds the runner free: the repair runs, and its brief still says attempt 1 of 2 —
    // the refusal never used one up.
    w.runner.script = [{ ok: true, version: 2, wrote: true, tests: { passed: 3, failed: 0 } }];
    w.runner.parityResults = {
      1: { ok: false, error: 'the field moved' },
      2: { ok: true, rows: 2, columns: ['id', 'caption', 'link'], rowKeys: ['a', 'b'] },
    };
    expect(await w.repairs.tick()).toBe(1);
    await until(() => w.prisma.builds.some((b: any) => b.origin === 'repair' && b.status === 'promoted'));
    expect(w.runner.builds).toHaveLength(2);
    expect(w.runner.builds[1].brief).toMatch(/repair attempt \*\*1 of 2\*\*/);
    expect(w.prisma.builds.filter((b: any) => b.origin === 'repair' && COUNTED.includes(b.status))).toHaveLength(1);
  });

  it('failing evidence bigger than the runner\'s declared file cap is trimmed to fit and SENT — never refused (BEA-1577)', async () => {
    // Thirty real posts make the evidence bigger than this runner\'s (small, declared) cap.
    const many = Array.from({ length: 30 }, (_, i) => post(`p${i + 1}`));
    const w = await setUp({ samples: [{ actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, data: { posts: many } }] });
    const CAP = 2_500;
    // The fake runner declares its limits the way the real one does on /status — the app reads
    // them from the runner and restates nothing.
    (w.runner as any).limits = async () => ({ fileBytes: CAP, filesBytes: 50_000_000 });
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [{ ok: true, version: 2, wrote: true, tests: { passed: 1, failed: 0 } }];
    w.runner.parityResults = {
      1: { ok: false, error: 'broken' },
      2: { ok: true, rows: 30, columns: ['id', 'caption', 'link'], rowKeys: many.map((p) => p.id) },
    };

    const out = await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    expect(out.outcome).toBe('promoted'); // the repair ran — the evidence was trimmed, not refused
    const sent = w.runner.builds[0].files['samples/failing.json'];
    expect(Buffer.byteLength(sent, 'utf8')).toBeLessThanOrEqual(CAP);
    const file = JSON.parse(sent); // valid JSON even after the cut
    expect(file.trimmed).toBe(true);
    expect(file.trimNote).toMatch(/cut to fit/);
    expect(file.failedWith).toBe(BROKEN); // the error and the judgement travel whole
    expect(file.rule).toBe('unrecognised');
  });
});

describe('self-heal: two tries, and then it stops (BEA-1393)', () => {
  it('after two failed repairs the job is genuinely switched off and the owner is told what was tried', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [
      { ok: false, version: 2, wrote: true, tests: { passed: 1, failed: 2 }, log: 'red' },
      { ok: false, version: 3, wrote: false, error: 'Codex did not write a worker.mjs in the build folder.' },
    ];

    const out = await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    expect(out.outcome).toBe('stopped');
    expect(w.runner.builds).toHaveLength(MAX_ATTEMPTS); // two, never three
    expect(w.runner.promotes).toHaveLength(0);
    // The second attempt was told what the first one tried, so it does not repeat it.
    expect(w.runner.builds[1].brief).toMatch(/already been tried/);
    expect(w.runner.builds[1].brief).toMatch(/did not pass/);

    // Genuinely paused: the existing convention, both columns.
    expect(w.prisma.agents).toEqual([{ id: 'ag1', enabled: false, pausedReason: expect.stringMatching(/repairs did not fix it/) }]);
    const told = w.alerts.said[w.alerts.said.length - 1];
    expect(told.headline).toMatch(/switched off/);
    expect(told.detail).toMatch(/Try 1: .*Try 2: /);
    expect(told.detail).toMatch(/run it the old way/); // retirement is his tap, and the notice offers it
    expect(w.world.calls).toHaveLength(1); // the run's own fetch, and not one call more
  });

  it('the same failure never re-enters the loop; a different failure still gets its own two tries', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-1'), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [{ ok: false, error: 'nope' }, { ok: false, error: 'nope again' }];
    await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    expect(w.runner.builds).toHaveLength(2);

    // The same break happens again: nothing is queued, and Codex is not asked a third time.
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-2'), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    expect(w.prisma.builds.filter((b: any) => b.status === 'queued')).toHaveLength(0);
    expect(await w.repairs.tick()).toBe(0);

    // A DIFFERENT break may still be repaired.
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-3'), { agentId: 'ag1', error: 'Only 1 row came through, and this job needs at least 5. Nothing was written.', runKind: 'worker' });
    const queued = w.prisma.builds.filter((b: any) => b.status === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0].cause).toBe('ag1|minRows|svc:instagram.search_hashtag');
  });

  it('a HELD repair is one of the two tries, and blocks another while the owner has not decided', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-1'), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [{ ok: true, version: 2, wrote: true, tests: { passed: 3, failed: 0 } }];
    w.runner.parityResults = {
      1: { ok: true, rows: 10, columns: ['id'], rowKeys: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'] },
      2: { ok: true, rows: 2, columns: ['id'], rowKeys: ['a', 'b'] },
    };
    expect((await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'))).outcome).toBe('held');

    // The same break happens again while the offer is still on his desk: nothing new is queued.
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-2'), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    expect(w.prisma.builds.filter((b: any) => b.status === 'queued')).toHaveLength(0);

    // He says no. Now it may be tried again — but ONCE, because the held one already used a try.
    const held = w.prisma.builds.find((b: any) => b.status === 'held');
    await w.repairs.decline('ag1', held.id);
    await w.repairs.onRunFailed(await failedRun(w.world, 'run-3'), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    w.runner.script = [{ ok: false, error: 'still no' }, { ok: false, error: 'a third try that must never happen' }];
    const out = await w.repairs.repair(w.prisma.builds.find((b: any) => b.status === 'queued'));
    expect(out.outcome).toBe('stopped');
    expect(w.runner.builds).toHaveLength(2); // the held one, then one more — never three
    // …and that last attempt was told what the held fix did, and that he turned it down.
    expect(w.runner.builds[1].brief).toMatch(/repair attempt \*\*2 of 2\*\*/);
    expect(w.runner.builds[1].brief).toMatch(/40% of the rows are different/);
    expect(w.runner.builds[1].brief).toMatch(/left the worker as it was/);
    expect(w.prisma.agents[0]).toMatchObject({ enabled: false });
  });

  it('a refusal on the SECOND attempt does not stop the job — the real try stays counted, the other stays owed (BEA-1577)', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    const queued = w.prisma.builds.find((b: any) => b.status === 'queued');
    w.runner.script = [
      { ok: false, version: 2, wrote: true, tests: { passed: 0, failed: 1 }, log: 'red' },
      { ok: false, error: 'This job is busy here (run) — try again when it settles.', notStarted: true },
    ];

    const out = await w.repairs.repair(queued);
    expect(out.outcome).toBe('busy');
    // NOT switched off: only ONE real Codex attempt is on the record, and the owner allowed two.
    expect(w.prisma.agents).toHaveLength(0);
    expect(w.prisma.builds.filter((b: any) => b.origin === 'repair' && COUNTED.includes(b.status))).toHaveLength(1);
    // The refused second attempt went back to the queue, with the evidence still riding on it.
    const requeued = w.prisma.builds.find((b: any) => b.status === 'queued');
    expect(requeued).toBeTruthy();
    expect(requeued.id).not.toBe(queued.id);
    expect(JSON.parse(requeued.sampleIds)).toHaveLength(1);

    // Later the runner is free and the retry REALLY fails: now it stops, exactly as today.
    w.runner.script = [{ ok: false, error: 'still red' }];
    expect((await w.repairs.repair(requeued)).outcome).toBe('stopped');
    expect(w.prisma.agents).toEqual([{ id: 'ag1', enabled: false, pausedReason: expect.stringMatching(/repairs did not fix it/) }]);
    // Three /build calls left the app, but only the two REAL attempts count anywhere.
    expect(w.runner.builds).toHaveLength(3);
    expect(w.prisma.builds.filter((b: any) => b.origin === 'repair' && COUNTED.includes(b.status))).toHaveLength(2);
  });

  it('a queued repair whose cause has already been stopped is closed, not tried again', async () => {
    const w = await setUp();
    await w.repairs.onRunFailed(await failedRun(w.world), { agentId: 'ag1', error: BROKEN, runKind: 'worker' });
    const queued = w.prisma.builds.find((b: any) => b.status === 'queued');
    // Two failed attempts already on the record for this cause.
    for (const error of ['try one', 'try two']) await w.prisma.workerBuild.create({ data: { agentId: 'ag1', version: 0, status: 'failed', origin: 'repair', cause: queued.cause, error } });
    expect(await w.repairs.repair(queued)).toEqual({ outcome: 'skipped' });
    expect(w.runner.builds).toHaveLength(0);
    expect(queued.status).toBe('failed');
    expect(w.prisma.agents).toHaveLength(0); // it was stopped once; it is not paused twice
  });
});
