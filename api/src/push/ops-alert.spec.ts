import { readFileSync } from 'fs';
import { join } from 'path';
import { opsAlert, opsAlertIfPlumbing, opsLocalDay, resetOpsAlerts, setOpsAlertTransport } from './ops-alert';
import { WorkerDispatchService } from '../worker/worker-dispatch.service';

/**
 * Plumbing failures phone home (BEA-1581).
 *
 * The rule under test: WHEN a failure lands in one of BEA-1580's plumbing classes, ONE ops alert
 * goes out per (class, agentId) per local day — instance id, class, agent/run id, the honest
 * internal sentence — and a customer-actionable failure never pages us. The alert leg may never
 * throw into the path it observes. No real Telegram is ever sent from here: the transport is a
 * stub, like every alert test in this codebase.
 */

type Sent = string[];
function stubTransport(): { sent: Sent; transport: { sendOps: (t: string) => Promise<{ sent: boolean }> } } {
  const sent: Sent = [];
  return { sent, transport: { sendOps: async (t: string) => { sent.push(t); return { sent: true }; } } };
}

afterEach(() => {
  setOpsAlertTransport(null); // never leak a transport between tests
  resetOpsAlerts();
  delete process.env.INSTANCE_ID;
});

describe('opsAlert — the seam', () => {
  it('one plumbing alert carries instance id, class, agent, run and the honest message', async () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    const went = await opsAlert({ klass: 'runner-unreachable', agentId: 'a1', runId: 'r1', message: 'the worker runner could not be reached (fetch failed)' });
    expect(went).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[mybrain]'); // the default instance id
    expect(sent[0]).toContain('runner-unreachable');
    expect(sent[0]).toContain('agent a1');
    expect(sent[0]).toContain('run r1');
    expect(sent[0]).toContain('the worker runner could not be reached (fetch failed)');
  });

  it('INSTANCE_ID names the instance — the myemo control plane knows whose plumbing it is', async () => {
    process.env.INSTANCE_ID = 'cust-7';
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    await opsAlert({ klass: 'worker-crash', agentId: 'a1', message: 'the worker exited with code 1' });
    expect(sent[0]).toContain('[cust-7]');
  });

  it('the second same-day occurrence for the same (class, agent) sends NOTHING', async () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    await opsAlert({ klass: 'runner-unreachable', agentId: 'a1', message: 'first' });
    const again = await opsAlert({ klass: 'runner-unreachable', agentId: 'a1', runId: 'r2', message: 'the sweeper saw it again' });
    expect(again).toBe(false);
    expect(sent).toHaveLength(1); // the trap: the sweeper fires every tick — the DAY is in the key
  });

  it('a different agent or a different class is its own alert', async () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    await opsAlert({ klass: 'runner-unreachable', agentId: 'a1', message: 'x' });
    await opsAlert({ klass: 'runner-unreachable', agentId: 'a2', message: 'x' });
    await opsAlert({ klass: 'worker-crash', agentId: 'a1', message: 'x' });
    expect(sent).toHaveLength(3);
  });

  it('the next local day alerts again — one a day, not one ever', async () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    const today = new Date('2026-08-29T10:00:00');
    const tomorrow = new Date('2026-08-30T10:00:00');
    expect(opsLocalDay(today)).not.toBe(opsLocalDay(tomorrow));
    await opsAlert({ klass: 'kit-mismatch', agentId: 'a1', message: 'x', now: today });
    await opsAlert({ klass: 'kit-mismatch', agentId: 'a1', message: 'x', now: tomorrow });
    expect(sent).toHaveLength(2);
  });

  it('no transport registered = nothing marked, so a late-registering transport still hears today', async () => {
    const first = await opsAlert({ klass: 'runner-unreachable', agentId: 'a1', message: 'before boot finished' });
    expect(first).toBe(false);
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    await opsAlert({ klass: 'runner-unreachable', agentId: 'a1', message: 'seen again after boot' });
    expect(sent).toHaveLength(1);
  });

  it('a throwing transport never throws out of the seam', async () => {
    setOpsAlertTransport({ sendOps: async () => { throw new Error('Telegram down'); } });
    await expect(opsAlert({ klass: 'worker-crash', agentId: 'a1', message: 'x' })).resolves.toBe(true);
  });
});

describe('opsAlertIfPlumbing — the classifier decides, never a second list', () => {
  it('a plumbing sentence alerts under its class', () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    opsAlertIfPlumbing('The installed worker (v2) has no readable meta.json, so its kit version is unknown — it needs a rebuild.', { agentId: 'a1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('worker-install-broken');
  });

  it('a customer-actionable failure never pages us — his six moves, not our pager', () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    opsAlertIfPlumbing('Connect Google Sheets first — open /tools, connect Google Sheets, then run this job again.', { agentId: 'a1' });
    opsAlertIfPlumbing('This job has no source called "svc:reddit.subreddit".', { agentId: 'a1' });
    opsAlertIfPlumbing('Reddit search timed out after 240 seconds; nothing was written.', { agentId: 'a1' });
    expect(sent).toHaveLength(0);
  });

  it('the boot reconciler sentences land in app-restart — orphans swept ARE our restart', () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    opsAlertIfPlumbing('Interrupted by an engine restart — please run it again.', { agentId: 'a1', runId: 'r1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('app-restart');
  });

  it('never throws, whatever the transport does', () => {
    setOpsAlertTransport({ sendOps: (() => { throw new Error('sync boom'); }) as any });
    expect(() => opsAlertIfPlumbing('the worker runner could not be reached (x)', { agentId: 'a1' })).not.toThrow();
  });
});

// ---- the observed path: a real call site, end to end ---------------------------------------------

/** The dispatch service with everything stubbed — the same minimal world its own spec builds. */
function dispatchWorld(runnerAnswer: any) {
  const finished: any[] = [];
  const agent: any = {
    appendStep: async () => undefined,
    finishRun: async (_runId: string, p: any) => { finished.push(p); return p; },
  };
  const tokens: any = { mint: async () => ({ token: 't', seed: { now: 1 } }), revokeRun: () => 0 };
  const runner: any = { run: async () => runnerAnswer };
  const journal: any = { list: async () => [{ seq: -1, fn: 'seed' }], forget: async () => 1 };
  const svc = new WorkerDispatchService(agent, {} as any, tokens, runner, journal);
  return { svc, finished };
}

describe('the dispatch call site (BEA-1581 locking test)', () => {
  it('a plumbing fallback alerts ONCE that day, and the run still falls back both times', async () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    const answer = { status: 'failed', notStarted: true, error: 'the worker runner could not be reached (fetch failed)' };
    const first = await dispatchWorld(answer).svc.run('r1', 'job-1');
    expect(first.fallback).toContain('Ran it the old way');
    const second = await dispatchWorld(answer).svc.run('r2', 'job-1');
    expect(second.fallback).toContain('Ran it the old way'); // the observed path is untouched
    expect(sent).toHaveLength(1); // same class, same agent, same day → one alert
  });

  it('a worker that ran and crashed alerts too, and the run is still failed honestly', async () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    const { svc, finished } = dispatchWorld({ status: 'failed', error: 'the worker exited with code 1' });
    await svc.run('r1', 'job-2');
    expect(finished[0]).toMatchObject({ status: 'failed', error: 'the worker exited with code 1' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('worker-crash');
  });

  it('a customer-actionable refusal at the same site sends nothing', async () => {
    const { sent, transport } = stubTransport();
    setOpsAlertTransport(transport);
    const { svc } = dispatchWorld({ status: 'failed', notStarted: true, error: 'This job has no source called "svc:reddit.subreddit"' });
    const r = await svc.run('r1', 'job-3');
    expect(r.fallback).toBeTruthy();
    expect(sent).toHaveLength(0);
  });

  it('a throwing transport never breaks the observed path', async () => {
    setOpsAlertTransport({ sendOps: async () => { throw new Error('Telegram down'); } });
    const { svc, finished } = dispatchWorld({ status: 'failed', notStarted: true, error: 'the worker runner could not be reached (fetch failed)' });
    const r = await svc.run('r1', 'job-4');
    expect(r.fallback).toContain('Ran it the old way'); // completed despite the alert leg failing
    expect(finished).toHaveLength(0); // the fallback path leaves the run to the ordinary road
  });
});

// ---- every detection point stays wired (the module-invariants pattern) ---------------------------

/**
 * The brief names SIX detection points, and the dispatch tests above exercise one for real. These
 * read the other five (and dispatch too) and assert the alert call is still there, next to the
 * detection it observes — so a refactor that drops the `opsAlertIfPlumbing` line fails HERE rather
 * than in a customer's silent night. A source test is the codebase's accepted lock for a rule that
 * must hold across files (module-invariants.spec.ts).
 */
describe('every BEA-1581 detection point calls the seam', () => {
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  const SITES: Array<[file: string, near: string]> = [
    ['worker/worker-dispatch.service.ts', 'The worker could not be started ('], // the mint-failure fallback
    ['worker/worker-dispatch.service.ts', 'worker road unavailable'], // the neverRan fallback (opsAlert with the already-computed class)
    ['worker/worker-dispatch.service.ts', 'The worker stopped without saying why.'], // ran-and-failed
    ['worker/worker-sweeper.service.ts', 'private async fail('],
    ['worker/worker-build.service.ts', 'is still the live worker.'],
    ['worker/worker-repair.service.ts', 'the runner refused before Codex started'],
    ['worker/worker-repair.service.ts', 'The repair itself could not run:'],
    ['worker/worker.controller.ts', 'customerWords(error)'],
    ['agent/agent.service.ts', 'Interrupted by an engine restart'],
  ];

  it.each(SITES)('%s alerts near "%s"', (file, near) => {
    const t = src(file);
    const i = t.indexOf(near);
    expect(i).toBeGreaterThan(-1);
    // Within a screenful either side of the detection — same function, not somewhere unrelated.
    expect(t.slice(Math.max(0, i - 1500), i + 1500)).toMatch(/opsAlertIfPlumbing\(|opsAlert\(\{/);
  });

  it('no call site grew its own class list — the classifier is the only judge', () => {
    // `plumbingClassOf` may be called (dispatch logs the class), but no file may test for a class
    // id by hand outside failure-words.ts and this suite's own assertions.
    for (const f of ['worker/worker-dispatch.service.ts', 'worker/worker-sweeper.service.ts', 'worker/worker-build.service.ts', 'worker/worker-repair.service.ts', 'worker/worker.controller.ts', 'agent/agent.service.ts']) {
      expect(src(f)).not.toMatch(/['"](runner-unreachable|runner-root-unusable|worker-install-broken|kit-mismatch|not-repeatable|worker-crash|app-restart|model-blank)['"]/);
    }
  });
});
