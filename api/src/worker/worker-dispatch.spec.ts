import { WorkerBuildService } from './worker-build.service';
import { WorkerDispatchService } from './worker-dispatch.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';
import { planHashOf } from './build-brief';
import { planFromAgent } from '../social/plan';

/**
 * The dispatch switch (BEA-1394, agent workers 9/10 — `specs/AGENT-WORKERS.md` §I).
 *
 * A promoted worker has been installed and INERT since BEA-1390. This is the piece that decides,
 * per run, whether a job goes down the worker road — and the rules it must never break:
 *
 *  • OFF is the default and it is silent: the owner's existing jobs behave exactly as today;
 *  • ON + a promoted, current worker is the ONLY way a run reaches the worker road;
 *  • a stale, missing or refused worker falls back to the plan runner FOR THAT RUN, with a step the
 *    owner can read — never a failed run just because the worker road was unavailable;
 *  • a worker that really RAN and failed is a real failure (the repair loop's business), and the run
 *    must never be re-done on the plan runner on top of what it already did.
 */

/** A direct-fetch (Social) job — `isDirectFetchAgent` wants sources with pinned arguments. */
function job(over: any = {}) {
  return {
    id: 'job-1',
    name: 'Smart home posts',
    prompt: 'KEEP_AS_FETCHED',
    tools: ['svc:instagram.search_hashtag'],
    toolArgs: { 'svc:instagram.search_hashtag': { actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' } } },
    outputDest: 'document',
    mode: 'run',
    useWorker: false,
    ...over,
  };
}

function world(opts: { job?: any; worker?: any; runner?: any; journal?: { seq: number; fn: string }[]; waitpoints?: any[] } = {}) {
  const steps: any[] = [];
  const finished: any[] = [];
  const kinds: any[] = [];
  const spawned: any[] = [];
  const forgotten: string[] = [];
  const removed: string[] = [];
  const agent: any = {
    getAgent: async () => opts.job ?? job(),
    appendStep: async (runId: string, s: any) => { steps.push({ runId, ...s }); },
    finishRun: async (runId: string, p: any) => { finished.push({ runId, ...p }); return p; },
    setRunKind: async (runId: string, kind: string) => { kinds.push({ runId, kind }); },
    setWorkerCleanup: (fn: any) => { (agent as any).cleanup = fn; },
  };
  // The REAL hash function, not a stub that always agrees (BEA-1462). The bug this replaced was
  // precisely two different hashes believing they were the same one, so a fake that cannot disagree
  // would test nothing. `WorkerBuildService.buildHashFor` needs no database for a job with no brief.
  const builds: any = {
    livePromoted: async () => opts.worker ?? null,
    buildHashFor: (job: any) => WorkerBuildService.prototype.buildHashFor.call({ briefs: undefined, goals: undefined }, job),
    whyNotBuildable: (job: any) => WorkerBuildService.prototype.whyNotBuildable.call({ goals: undefined }, job),
  };
  const tokens: any = {
    mint: async (runId: string, agentId: string) => ({ token: `t-${runId}`, seed: { now: 1, random: 2 }, runId, agentId }),
    revokeRun: () => 0,
  };
  const runner: any = {
    run: async (input: any) => { spawned.push(input); return opts.runner ?? { status: 'done', rows: 3 }; },
    remove: async (jobId: string) => { removed.push(jobId); return { ok: true, removed: true }; },
  };
  const journal: any = {
    list: async () => opts.journal ?? [{ seq: -1, fn: 'seed' }],
    forget: async (runId: string) => { forgotten.push(runId); return 1; },
  };
  // The waitpoints of the run, as the database holds them — the dispatcher asks it before it
  // finishes a run as done (BEA-1395).
  const waitpoints: any[] = opts.waitpoints ?? [];
  const prisma: any = { waitpoint: { findFirst: async ({ where }: any) => waitpoints.find((w) => w.runId === where.runId && w.status === where.status) || null } };
  const svc = new WorkerDispatchService(agent, builds, tokens, runner, journal, undefined, prisma);
  return { svc, agent, steps, finished, kinds, spawned, forgotten, removed, runner };
}

const promoted = (over: any = {}) => ({ id: 'b1', version: 3, status: 'promoted', planHash: planHashOf(planFromAgent(job())), ...over });

describe('The dispatch switch — which road a run takes (BEA-1394)', () => {
  it('is OFF by default: a job with no switch never asks about a worker at all', async () => {
    const { svc } = world({ job: job(), worker: promoted() });
    const d = await svc.decide('job-1');
    expect(d.use).toBe(false);
    expect(d.say).toBeUndefined(); // silent — the owner's existing jobs read exactly as they did
  });

  it('a PROMOTED worker with the switch off still never runs', async () => {
    const { svc, spawned } = world({ job: job({ useWorker: false }), worker: promoted() });
    expect((await svc.decide('job-1')).use).toBe(false);
    expect(spawned).toHaveLength(0);
  });

  it('the switch ON with a current worker takes the worker road', async () => {
    const { svc } = world({ job: job({ useWorker: true }), worker: promoted() });
    const d = await svc.decide('job-1');
    expect(d.use).toBe(true);
    expect(d.version).toBe(3);
  });

  it('ON with no worker built yet falls back and says so', async () => {
    const { svc } = world({ job: job({ useWorker: true }), worker: null });
    const d = await svc.decide('job-1');
    expect(d.use).toBe(false);
    expect(d.say).toMatch(/no worker is built/i);
  });

  it('a STALE worker (the plan changed) falls back for that run and says which version is out of date', async () => {
    const { svc } = world({ job: job({ useWorker: true }), worker: promoted({ planHash: 'a-hash-from-an-older-plan' }) });
    const d = await svc.decide('job-1');
    expect(d.use).toBe(false);
    expect(d.say).toMatch(/plan changed/i);
    expect(d.say).toMatch(/v3/);
  });

  it('a job with nothing to compile is never dispatched to a worker, even with the switch on', async () => {
    const { svc } = world({ job: { id: 'job-1', name: 'Research', prompt: 'go', useWorker: true, tools: [], toolArgs: null }, worker: promoted() });
    const d = await svc.decide('job-1');
    expect(d.use).toBe(false);
    // The reason is now the BUILD's own words, because it is the build's own rule (BEA-1462) — one
    // question asked in one place. It used to be `isDirectFetchAgent`, which asks something else
    // entirely ("can the plan runner do this whole job") and answered no for any brief-built job
    // that writes somewhere — so a job with a green promoted worker went down the engine road for
    // ever while its own Settings screen said the worker was fine.
    expect(d.say).toMatch(/nothing to fetch from yet|nothing to build/i);
  });

  /**
   * THE OWNER'S OWN AGENT (BEA-1462).
   *
   * "Nightly email summary": built from an approved brief, reads Gmail, writes a document, messages
   * him. It had a green, promoted worker and `useWorker: true`, and it went down the ENGINE road on
   * every single run — because `decideFor` asked `isDirectFetchAgent` ("can the plan runner do this
   * whole job?"), which answers no for exactly this shape. Its own Settings screen said
   * `compilable: true` at the same moment. Two answers to one question, on one job.
   */
  it('a brief-built job that reads and writes reaches its worker', async () => {
    const brieflike = {
      id: 'job-1',
      name: 'Nightly email summary',
      prompt: 'Summarise what mattered.',
      origin: 'brief',
      useWorker: true,
      tools: ['svc:gmail.fetch_emails'],
      toolArgs: { 'svc:gmail.fetch_emails': { actionId: 'svc:gmail.fetch_emails', args: { max_results: 25 } } },
      outputDest: 'document',
      notifyWhatsApp: true,
    };
    const hash = await WorkerBuildService.prototype.buildHashFor.call({ briefs: undefined }, brieflike);
    const { svc } = world({ job: brieflike, worker: promoted({ planHash: hash }) });

    const d = await svc.decide('job-1');
    expect(d.use).toBe(true);
    expect(d.say).toBeUndefined(); // nothing to explain — it just runs on its worker
  });

  it('and the dispatcher agrees with the SCREEN about whether it can be compiled', async () => {
    // One rule, asked in one place. If these two ever answer differently again, the owner reads
    // "worker v1, current" on a job that has never once used it.
    const brieflike = { id: 'job-1', name: 'N', prompt: 'p', origin: 'brief', useWorker: true, tools: ['svc:gmail.fetch_emails'], toolArgs: { 'svc:gmail.fetch_emails': { actionId: 'svc:gmail.fetch_emails', args: {} } }, outputDest: 'document' };
    expect(WorkerBuildService.whyNotCompilableFor(brieflike)).toBeFalsy();
    const { svc } = world({ job: brieflike, worker: promoted({ planHash: await WorkerBuildService.prototype.buildHashFor.call({ briefs: undefined }, brieflike) }) });
    expect((await svc.decide('job-1')).use).toBe(true);
  });

  it('a worker that RAN and finished owns the run — no fallback', async () => {
    const { svc, finished, spawned } = world({ job: job({ useWorker: true }), worker: promoted(), runner: { status: 'done', rows: 5 } });
    const out = await svc.run('run-1', 'job-1', { version: 3 });
    expect(out.fallback).toBeUndefined();
    expect(spawned[0]).toMatchObject({ jobId: 'job-1', runId: 'run-1', token: 't-run-1' });
    expect(finished[0]).toMatchObject({ status: 'done' });
  });

  it('a worker that parked on a question owns the run — nothing is finished or fallen back', async () => {
    const { svc, finished } = world({ job: job({ useWorker: true }), worker: promoted(), runner: { status: 'waiting', waitpointId: 'wp1' } });
    const out = await svc.run('run-1', 'job-1');
    expect(out.fallback).toBeUndefined();
    expect(finished).toHaveLength(0);
  });

  it('a clean EXIT with a question still open is a parked run, not a finished one (BEA-1395)', async () => {
    // A worker that asks exits, and an exit says nothing: the runner reads that as `done`, and
    // `finishRun` cancels every pending waitpoint. The acceptance run met exactly this — a real
    // question on the owner's phone that could never be answered, and a run that claimed it was
    // done having written nothing. The kit now says "waiting" on its way out; this is the belt to
    // that brace, and it covers every worker already built against the older kit.
    const { svc, finished } = world({
      job: job({ useWorker: true }),
      worker: promoted(),
      runner: { status: 'done', rows: null },
      waitpoints: [{ id: 'wp1', runId: 'run-1', status: 'pending' }],
    });
    const out = await svc.run('run-1', 'job-1');
    expect(out.fallback).toBeUndefined();
    expect(finished).toHaveLength(0);
  });

  it('a worker the runner REFUSED (kit too new) falls back — the run is not failed', async () => {
    const { svc, finished, forgotten } = world({
      job: job({ useWorker: true }),
      worker: promoted(),
      runner: { status: 'failed', kitRefused: true, notStarted: true, error: 'This job’s worker was built for kit v2 and My Brain is on kit v1' },
    });
    const out = await svc.run('run-1', 'job-1');
    expect(out.fallback).toMatch(/the old way/i);
    expect(out.fallback).toMatch(/kit v2/);
    expect(finished).toHaveLength(0); // nothing failed — the run carries on the old way
    expect(forgotten).toContain('run-1'); // and it starts the plan road with a clean journal
  });

  it('a runner that is not installed at all falls back, it does not fail the run', async () => {
    const { svc, finished } = world({
      job: job({ useWorker: true }),
      worker: promoted(),
      runner: { status: 'failed', notStarted: true, error: 'The worker could not be started — the worker runner could not be reached' },
    });
    const out = await svc.run('run-1', 'job-1');
    expect(out.fallback).toMatch(/could not be reached/);
    expect(finished).toHaveLength(0);
  });

  it('a worker that started and then FAILED fails the run — it is never re-done on the plan runner', async () => {
    const { svc, finished } = world({
      job: job({ useWorker: true }),
      worker: promoted(),
      runner: { status: 'failed', error: 'Only 0 of 3 rows have a link' },
    });
    const out = await svc.run('run-1', 'job-1');
    expect(out.fallback).toBeUndefined();
    expect(finished[0]).toMatchObject({ status: 'failed', error: 'Only 0 of 3 rows have a link' });
  });

  it('a "not started" answer is IGNORED when the journal shows the worker already did something', async () => {
    // The client marks a timeout as `notStarted`, and a worker that really was working would then be
    // re-run from the top on the plan runner — a second fetch, a second sheet write, a second message.
    const { svc, finished } = world({
      job: job({ useWorker: true }),
      worker: promoted(),
      runner: { status: 'failed', notStarted: true, error: 'the worker runner did not answer in time' },
      journal: [{ seq: -1, fn: 'seed' }, { seq: 0, fn: 'fetchSource' }, { seq: 1, fn: 'writeSheet' }],
    });
    const out = await svc.run('run-1', 'job-1');
    expect(out.fallback).toBeUndefined();
    expect(finished[0]).toMatchObject({ status: 'failed' });
  });

  it('deleting an agent asks the runner to remove its worker folders', async () => {
    const { svc, removed } = world();
    await svc.forget('job-1');
    expect(removed).toEqual(['job-1']);
  });
});

describe('The one door — `startRun` obeys the switch (BEA-1394)', () => {
  /** The bridge with everything it does not need left out. */
  function bridge(agent: any, locks: any) {
    const b: any = new HermesBridgeService(agent, {} as any, {} as any, {} as any, { complete: async () => '' } as any, {} as any, undefined, undefined, undefined, undefined, undefined, undefined, locks);
    b.executed = [];
    b.execute = async (runId: string) => { b.executed.push(runId); };
    return b;
  }

  function bridgeWorld(decision: any, runOut: any = {}) {
    const steps: any[] = [];
    const agent: any = {
      createRun: async () => ({ id: 'run-1' }),
      appendStep: async (runId: string, s: any) => { steps.push({ runId, ...s }); },
      finishRun: async () => undefined,
      setRunKind: async () => undefined,
    };
    const locks: any = { claim: async () => ({ ok: true, holder: 'h' }), attachRun: async () => undefined, release: async () => undefined };
    const b = bridge(agent, locks);
    const ran: any[] = [];
    b.setWorkerDispatch({
      decide: async () => decision,
      run: async (runId: string, agentId: string, o: any) => { ran.push({ runId, agentId, ...o }); return runOut; },
    });
    return { b, steps, ran };
  }

  it('the switch off: the ordinary road runs, nothing is said, no worker is asked for', async () => {
    const { b, steps, ran } = bridgeWorld({ use: false });
    await b.startRun({ prompt: 'go', title: 'Job', agentId: 'job-1' });
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toHaveLength(0);
    expect(b.executed).toEqual(['run-1']);
    expect(steps).toHaveLength(0);
  });

  it('the switch on: the worker road runs and `execute()` is never reached', async () => {
    const { b, ran } = bridgeWorld({ use: true, version: 3 }, {});
    await b.startRun({ prompt: 'go', title: 'Job', agentId: 'job-1' });
    await new Promise((r) => setTimeout(r, 5));
    expect(ran[0]).toMatchObject({ runId: 'run-1', agentId: 'job-1', version: 3 });
    expect(b.executed).toEqual([]);
  });

  it('a stale worker: the reason is a VISIBLE step and the run carries on the old way', async () => {
    const { b, steps, ran } = bridgeWorld({ use: false, say: 'Ran it the old way — the plan changed since worker v2 was built.' });
    await b.startRun({ prompt: 'go', title: 'Job', agentId: 'job-1' });
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toHaveLength(0);
    expect(steps[0]).toMatchObject({ runId: 'run-1', status: 'info' });
    expect(steps[0].label).toMatch(/plan changed/);
    expect(b.executed).toEqual(['run-1']);
  });

  it('a worker road that was unavailable mid-start: the step says so and the ordinary road takes over', async () => {
    const { b, steps, ran } = bridgeWorld({ use: true, version: 3 }, { fallback: 'Ran it the old way for this run — the worker runner could not be reached.' });
    await b.startRun({ prompt: 'go', title: 'Job', agentId: 'job-1' });
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toHaveLength(1);
    expect(steps.map((s) => s.label).join(' ')).toMatch(/could not be reached/);
    expect(b.executed).toEqual(['run-1']); // the SAME run row, the ordinary road
  });

  it('a run with no job (a one-off prompt) never touches the worker road', async () => {
    const { b, ran } = bridgeWorld({ use: true, version: 3 });
    await b.startRun({ prompt: 'just answer this' });
    await new Promise((r) => setTimeout(r, 5));
    expect(ran).toHaveLength(0);
    expect(b.executed).toEqual(['run-1']);
  });
});

/**
 * The run screen is the owner's, not a log (BEA-1462).
 *
 * `whyNotCompilableFor()` writes sentences that START a paragraph on the build screen. The
 * dispatcher now reuses them — which is the point, one rule in one place — but stitching one
 * straight onto "Ran it the old way — " produced a capital letter mid-sentence.
 */
describe('the fallback sentence reads like a sentence', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { lowerFirst } = require('./worker-dispatch.service');

  it('lowercases a stand-alone sentence being joined onto another', () => {
    expect(lowerFirst('This job has nothing to fetch from yet, so there is nothing to build.'))
      .toBe('this job has nothing to fetch from yet, so there is nothing to build.');
  });

  it('leaves an action id alone — "Svc:" would be worse than the capital', () => {
    expect(lowerFirst('svc:gmail.send_email is not something an agent can use.')).toBe('svc:gmail.send_email is not something an agent can use.');
    expect(lowerFirst('AI News Daily is not something an agent can use.')).toBe('AI News Daily is not something an agent can use.');
  });

  it('survives empty and rubbish input rather than throwing on the run screen', () => {
    expect(lowerFirst('')).toBe('');
    expect(lowerFirst(null as any)).toBe('');
  });
});
