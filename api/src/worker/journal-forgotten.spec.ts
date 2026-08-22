import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { AgentService } from '../agent/agent.service';
import { RunLockService } from '../agent/run-lock.service';
import { RunJournalService } from './run-journal.service';
import { WorkerSweeperService } from './worker-sweeper.service';

/**
 * A finished worker run leaves NO journal behind, whichever road ended it (BEA-1401).
 *
 * The journal exists for exactly one purpose — making a resume free — so a run that has reached a
 * terminal state has no use for it, and keeping it means whole fetched tables sitting in the
 * database and in every nightly backup after that. Until this issue the worker's own `/finish` was
 * the only place that dropped it, which is one road of four: the stall watchdog, a deadline with no
 * default and an overtaken run all leaked, and those are precisely the roads where the worker has
 * already exited and can never call anything.
 *
 * A fake Prisma would prove nothing here, exactly as in `delete-agent.spec.ts`: the question is
 * whether the rows really disappear from a real database, driven by the REAL sweeper through the
 * REAL `finishRun()`.
 */

const API_DIR = join(__dirname, '..', '..');
const TEST_DB = join(API_DIR, 'prisma', 'test-journal-forgotten.db');
const URL = `file:${TEST_DB}`;

jest.setTimeout(300_000);

let prisma: any;
let agents: AgentService;
let journal: RunJournalService;
let sweeper: WorkerSweeperService;
const told: string[] = [];

beforeAll(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  execSync('npx prisma migrate deploy', { cwd: API_DIR, env: { ...process.env, DATABASE_URL: URL }, stdio: 'ignore' });
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  agents = new AgentService(prisma, new RunLockService(prisma));
  journal = new RunJournalService(prisma);
  // The one registration the app makes at boot (`WorkerDispatchService.onModuleInit`).
  agents.setJournalCleanup((runId: string) => journal.forget(runId));
  const tokens: any = { mint: async (runId: string) => ({ token: `t-${runId}`, seed: { now: 1, random: 1 } }), revokeRun: () => 0 };
  const runner: any = { run: async () => ({ status: 'done', rows: 1 }) };
  const alerts: any = { runFailed: async (_n: string, why: string) => { told.push(why); return { sent: true }; } };
  sweeper = new WorkerSweeperService(prisma, agents, tokens, runner, alerts, new RunLockService(prisma));
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  for (const f of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (existsSync(f)) rmSync(f);
});

/** One worker run with a journal that holds a whole fetched table — the thing that must not linger. */
async function runWithJournal(over: any = {}) {
  const job = await prisma.agent.create({ data: { name: 'Smart home posts', prompt: 'go' } });
  const run = await prisma.agentRun.create({
    data: { agentId: job.id, title: 'Smart home posts', status: 'running', runKind: 'worker', stepLog: '[]', startedAt: new Date(), ...over },
  });
  await journal.write(run.id, 0, `k-${run.id}-0`, 'fetchSource', { table: { columns: ['id'], rows: [['p1'], ['p2']] } });
  await journal.write(run.id, 1, `k-${run.id}-1`, 'writeSheet', { ok: true, url: 'https://sheet' });
  expect((await journal.list(run.id)).length).toBe(2);
  return { job, run };
}

const rowsFor = (runId: string) => prisma.runJournal.count({ where: { runId } });

describe('a finished worker run leaves no journal (BEA-1401)', () => {
  it('the stall watchdog: a run that stopped making progress', async () => {
    const { run } = await runWithJournal({ startedAt: new Date(Date.now() - 60 * 60_000) });
    expect(await sweeper.sweepStalls()).toBe(1);
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } })).status).toBe('failed');
    expect(await rowsFor(run.id)).toBe(0);
  });

  it('a deadline with no default: the question nobody answered', async () => {
    const { run } = await runWithJournal({ status: 'awaiting_input' });
    await prisma.waitpoint.create({
      data: {
        runId: run.id,
        question: 'Which city?',
        resumeToken: `tok-${run.id}`,
        status: 'pending',
        defaultValue: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    expect(await sweeper.sweepDeadlines()).toBe(1);
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } })).status).toBe('failed');
    expect(await rowsFor(run.id)).toBe(0);
  });

  it('overtaken: a late answer to a run a newer one already did', async () => {
    const { job, run } = await runWithJournal({ sessionId: 'worker', startedAt: new Date(Date.now() - 3 * 3600_000) });
    await prisma.waitpoint.create({ data: { runId: run.id, question: 'Carry on?', resumeToken: `tok2-${run.id}`, status: 'answered', answer: 'Carry on' } });
    // A newer run of the same job that has already finished — the reason this one must stop.
    await prisma.agentRun.create({ data: { agentId: job.id, title: 'Smart home posts', status: 'done', runKind: 'worker', startedAt: new Date(Date.now() - 3600_000), endedAt: new Date() } });

    expect(await sweeper.resumeAnswered()).toBe(0); // it was stopped, not spawned again
    const after = await prisma.agentRun.findUnique({ where: { id: run.id } });
    expect(after.status).toBe('done');
    expect(String(after.resultText)).toMatch(/newer run/i);
    expect(await rowsFor(run.id)).toBe(0);
  });

  it('the worker\'s own finish, which is the road that always worked', async () => {
    const { run } = await runWithJournal();
    await agents.finishRun(run.id, { status: 'done', resultText: '2 rows' });
    expect(await rowsFor(run.id)).toBe(0);
  });

  it('a cancelled run, and one a restart orphaned — the two roads that write the row themselves', async () => {
    const cancelled = await runWithJournal();
    await agents.cancelRun(cancelled.run.id);
    expect(await rowsFor(cancelled.run.id)).toBe(0);

    // A worker run left `running` by a deploy: the boot reconciler fails it, and it is just as
    // terminal as any other ending.
    const orphan = await runWithJournal({ sessionId: null });
    expect(await agents.reconcileOrphans()).toBeGreaterThan(0);
    expect((await prisma.agentRun.findUnique({ where: { id: orphan.run.id } })).status).toBe('failed');
    expect(await rowsFor(orphan.run.id)).toBe(0);
  });

  it('a run on the plan road is not the worker road, and nothing here touches it', async () => {
    const { run } = await runWithJournal({ runKind: 'plan', startedAt: new Date(Date.now() - 60 * 60_000) });
    await sweeper.sweepStalls();
    expect((await prisma.agentRun.findUnique({ where: { id: run.id } })).status).toBe('failed'); // the watchdog covers both roads
    // …but only a WORKER run has a journal to drop, so the cleanup is asked for worker runs only.
    expect(await rowsFor(run.id)).toBe(2);
    await prisma.runJournal.deleteMany({ where: { runId: run.id } });
  });
});
