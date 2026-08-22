import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { AgentService } from './agent.service';
import { RunLockService, isJobBusy } from './run-lock.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';

/**
 * The per-job run lock against a REAL SQLite database (BEA-1388, `specs/AGENT-WORKERS.md` §G).
 *
 * A fake Prisma would prove nothing here. The whole point of the piece is that the claim is a
 * compare-and-set the DATABASE arbitrates — a UNIQUE index and one conditional UPDATE — so the only
 * honest test is real racers against a real SQLite file, with the real migrations applied.
 */

const API_DIR = join(__dirname, '..', '..');
const TEST_DB = join(API_DIR, 'prisma', 'test-run-lock.db');
const URL = `file:${TEST_DB}`;

jest.setTimeout(300_000);

describe('Per-job run lock — one run at a time (BEA-1388)', () => {
  let prisma: any;
  let locks: RunLockService;

  beforeAll(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    execSync('npx prisma migrate deploy', { cwd: API_DIR, env: { ...process.env, DATABASE_URL: URL }, stdio: 'ignore' });
    const { PrismaClient } = require('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: URL } } });
    locks = new RunLockService(prisma);
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
    for (const f of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (existsSync(f)) rmSync(f);
  });

  beforeEach(async () => {
    await prisma.jobRunLock.deleteMany({});
    await prisma.flowRun.deleteMany({});
    await prisma.flow.deleteMany({});
    await prisma.agentRun.deleteMany({});
    await prisma.agent.deleteMany({});
  });

  const job = async (over: any = {}) => prisma.agent.create({ data: { name: 'Smart Home Instagram', prompt: 'fetch it', ...over } });

  it('two starts of one job race and exactly ONE wins', async () => {
    const a = await job();
    const both = await Promise.all([locks.claim(a.id, { reason: 'the scheduled run' }), locks.claim(a.id, { reason: 'a run you started' })]);
    expect(both.filter((r) => r.ok).length).toBe(1);
    expect(await prisma.jobRunLock.count()).toBe(1);
    const loser = both.find((r) => !r.ok)!;
    expect(loser.held?.jobId).toBe(a.id);
    expect(loser.held?.reason).toBeTruthy(); // the loser can say what is going on
  });

  it('twenty racers on one job still produce exactly one holder, and every loser is told who has it', async () => {
    const a = await job();
    const all = await Promise.all(Array.from({ length: 20 }, (_, i) => locks.claim(a.id, { reason: `racer ${i}` })));
    const won = all.filter((r) => r.ok);
    expect(won.length).toBe(1);
    expect(await prisma.jobRunLock.count()).toBe(1);
    for (const lost of all.filter((r) => !r.ok)) expect(lost.held?.holder).toBe(won[0].holder);
  });

  it('two different jobs never block each other', async () => {
    const [a, b] = [await job(), await job({ name: 'Daily brief' })];
    expect((await locks.claim(a.id)).ok).toBe(true);
    expect((await locks.claim(b.id)).ok).toBe(true);
  });

  it('releasing hands the job to the next start — and only the holder may release', async () => {
    const a = await job();
    const mine = await locks.claim(a.id);
    expect((await locks.claim(a.id)).ok).toBe(false);
    expect(await locks.release('h_somebody-else')).toBe(false); // a stranger cannot free my run
    expect((await locks.claim(a.id)).ok).toBe(false);
    expect(await locks.release(mine.holder!)).toBe(true);
    expect((await locks.claim(a.id)).ok).toBe(true);
  });

  it('a holder that dies frees the job at the timeout — and only one racer takes it over', async () => {
    const a = await job();
    const dead = await locks.claim(a.id, { reason: 'a run that crashed', ttlMs: 40 });
    expect(dead.ok).toBe(true);
    expect((await locks.claim(a.id)).ok).toBe(false); // still held while it is alive
    expect(await locks.heldBy(a.id)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 60)); // …the holder never came back

    expect(await locks.heldBy(a.id)).toBeNull(); // an expired lock holds nothing
    const racers = await Promise.all([locks.claim(a.id), locks.claim(a.id), locks.claim(a.id)]);
    expect(racers.filter((r) => r.ok).length).toBe(1);
    expect(racers.find((r) => r.ok)!.tookOver).toBe(true);
    expect(await prisma.jobRunLock.count()).toBe(1);
    // The dead holder coming back must not free the run that replaced it.
    expect(await locks.release(dead.holder!)).toBe(false);
    expect((await locks.claim(a.id)).ok).toBe(false);
  });

  it('the worker road re-claims its own run after a pause, and is refused somebody else\'s job', async () => {
    const a = await job();
    const first = await locks.claimForRun(a.id, 'run-1', { reason: 'a worker run', ttlMs: 40 });
    expect(first.ok).toBe(true);
    // A second spawn of the SAME run pushes the timeout out instead of failing.
    const again = await locks.claimForRun(a.id, 'run-1', { reason: 'a worker run' });
    expect(again.ok).toBe(true);
    expect(again.holder).toBe(first.holder);
    expect((await locks.claimForRun(a.id, 'run-2')).ok).toBe(false); // a different run of the same job
    await locks.releaseForRun('run-1');
    expect((await locks.claimForRun(a.id, 'run-2')).ok).toBe(true);
  });

  // ---- through the real service, the way a run really starts ------------------------------------

  /** The bridge with everything it does not need left out; `execute()` never runs in these tests. */
  function bridge(agent: AgentService) {
    const b: any = new HermesBridgeService(agent, {} as any, {} as any, {} as any, { complete: async () => '' } as any, {} as any, undefined, undefined, undefined, undefined, undefined, undefined, locks);
    b.execute = async () => undefined; // the run is started, not driven
    return b as HermesBridgeService;
  }

  it('two simultaneous starts of one job create exactly ONE run row', async () => {
    const agent = new AgentService(prisma, locks);
    const b = bridge(agent);
    const a = await job();
    const started = await Promise.all([
      b.startRun({ prompt: 'go', title: a.name, agentId: a.id, lockReason: 'the scheduled run' }).catch((e) => e),
      b.startRun({ prompt: 'go', title: a.name, agentId: a.id, lockReason: 'a run you started' }).catch((e) => e),
    ]);
    const runs = started.filter((r: any) => r?.id);
    const refused = started.filter((r: any) => isJobBusy(r));
    expect(runs.length).toBe(1);
    expect(refused.length).toBe(1);
    expect(refused[0].getStatus()).toBe(409); // the owner is TOLD, never silently swallowed
    expect(String(refused[0].message)).toContain('already running');
    expect(await prisma.agentRun.count()).toBe(1); // and no junk run row for the one that lost
  });

  it('a run that ends in ANY terminal state gives the job back', async () => {
    const agent = new AgentService(prisma, locks);
    const b = bridge(agent);
    for (const end of ['done', 'failed', 'cancelled'] as const) {
      const a = await job({ name: `job-${end}` });
      const run: any = await b.startRun({ prompt: 'go', agentId: a.id });
      expect(await locks.heldBy(a.id)).toBeTruthy();
      if (end === 'cancelled') await agent.cancelRun(run.id);
      else await agent.finishRun(run.id, { status: end });
      expect(await locks.heldBy(a.id)).toBeNull();
      const next: any = await b.startRun({ prompt: 'again', agentId: a.id }); // the job runs again at once
      expect(next.id).toBeTruthy();
    }
  });

  it('a run with no job is never locked (a one-off prompt, bookmark research)', async () => {
    const agent = new AgentService(prisma, locks);
    const b = bridge(agent);
    const runs = await Promise.all([b.startRun({ prompt: 'one' }), b.startRun({ prompt: 'two' })]);
    expect(runs.every((r: any) => r?.id)).toBe(true);
    expect(await prisma.jobRunLock.count()).toBe(0);
  });

  it('a restart frees the jobs it orphaned, so the next schedule fires (BEA-629 + BEA-1388)', async () => {
    const agent = new AgentService(prisma, locks);
    const b = bridge(agent);
    const a = await job();
    const run: any = await b.startRun({ prompt: 'go', agentId: a.id });
    expect(await locks.heldBy(a.id)).toBeTruthy();
    await agent.reconcileOrphans(); // what boot does after a deploy killed the run mid-flight
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } })).status).toBe('failed');
    expect(await locks.heldBy(a.id)).toBeNull();
  });

  it('the Flow tab and the Run button are two doors on ONE job, and the lock holds both (BEA-1388)', async () => {
    const { FlowRunnerService } = require('../flows/flows-runner.service');
    const agent = new AgentService(prisma, locks);
    const b = bridge(agent);
    /** The runner with everything it does not need left out; `execute()` never really runs here. */
    const runner: any = new FlowRunnerService(prisma, b, agent, {} as any, {} as any, {} as any, {} as any, { notifyFlowDone: async () => undefined } as any, {} as any,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, locks);
    runner.execute = async () => undefined;

    const a = await job();
    const flow = await prisma.flow.create({ data: { name: a.name, agentId: a.id } });

    // The job's own Run button first — the Flow tab's Run must then be refused, not run alongside.
    const run: any = await b.startRun({ prompt: 'go', title: a.name, agentId: a.id, lockReason: 'a run you started' });
    await expect(runner.start(flow.id)).rejects.toMatchObject({ name: 'JobBusyError' });
    expect(await prisma.flowRun.count()).toBe(0); // and no half-run left in the flow's history
    await agent.finishRun(run.id, { status: 'done' });

    // …and the other way round: a flow run of the job blocks the job's Run button.
    const started = await runner.start(flow.id);
    expect(started.runId).toBeTruthy();
    await expect(b.startRun({ prompt: 'go', title: a.name, agentId: a.id })).rejects.toMatchObject({ name: 'JobBusyError' });
    await runner.cancelRun(started.runId); // any terminal state gives the job back
    expect(await locks.heldBy(a.id)).toBeNull();
    expect((await b.startRun({ prompt: 'go', agentId: a.id }) as any).id).toBeTruthy();
  });

  it('a standalone flow with no job is never locked', async () => {
    const { FlowRunnerService } = require('../flows/flows-runner.service');
    const runner: any = new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { notifyFlowDone: async () => undefined } as any, {} as any,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, locks);
    runner.execute = async () => undefined;
    const flow = await prisma.flow.create({ data: { name: 'A flow of its own' } });
    expect((await runner.start(flow.id)).runId).toBeTruthy();
    expect(await prisma.jobRunLock.count()).toBe(0);
  });

  it('deleting a job leaves no lock row behind', async () => {
    const agent = new AgentService(prisma, locks);
    const a = await job();
    await locks.claim(a.id);
    await agent.deleteAgent(a.id);
    expect(await prisma.jobRunLock.count()).toBe(0);
  });
});
