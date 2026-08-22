import { execSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { AgentService } from './agent.service';
import { RunLockService } from './run-lock.service';

/**
 * Housekeeping — deleting an agent leaves NOTHING behind (BEA-1394, `specs/AGENT-WORKERS.md` §I).
 *
 * Half of what a job owns has no foreign key back to `Agent`, so it is hand-kept — which is exactly
 * the bug class CLAUDE.md flags and the reason the spec says "a test asserts nothing is left behind,
 * because this is the bug that gets written twice". A fake Prisma would prove nothing here: the point
 * is which rows really disappear from a real database, cascades and hand-deletes together.
 *
 * The per-run cost rides along on the same real database, because it is read the same way — summed
 * from the run's own `ToolCall` rows, with the AI tokens counted on the run row itself.
 */

const API_DIR = join(__dirname, '..', '..');
const TEST_DB = join(API_DIR, 'prisma', 'test-delete-agent.db');
const URL = `file:${TEST_DB}`;

jest.setTimeout(300_000);

let prisma: any;
let agents: AgentService;

beforeAll(() => {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  execSync('npx prisma migrate deploy', { cwd: API_DIR, env: { ...process.env, DATABASE_URL: URL }, stdio: 'ignore' });
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient({ datasources: { db: { url: URL } } });
  agents = new AgentService(prisma, new RunLockService(prisma));
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  for (const f of [TEST_DB, `${TEST_DB}-journal`, `${TEST_DB}-wal`, `${TEST_DB}-shm`]) if (existsSync(f)) rmSync(f);
});

describe('Deleting an agent leaves nothing behind (BEA-1394 §I)', () => {

  /** One job with every kind of row that hangs off it — the whole tail this delete has to sweep. */
  async function jobWithEverything(name = 'Smart home posts') {
    const job = await prisma.agent.create({ data: { name, prompt: 'go' } });
    const run = await prisma.agentRun.create({ data: { agentId: job.id, title: name, status: 'running', runKind: 'worker' } });
    await prisma.waitpoint.create({ data: { runId: run.id, question: 'Which city?', resumeToken: `tok-${run.id}`, status: 'pending' } });
    await prisma.runJournal.create({ data: { runId: run.id, seq: 0, stepKey: `k-${run.id}-0`, fn: 'fetchSource', result: Buffer.from('x'), bytes: 1 } });
    await prisma.socialWatch.create({ data: { agentId: job.id, actionId: 'svc:instagram.search_hashtag', argsHash: 'h1', lastHash: 'x', lastResult: '{}' } });
    await prisma.workerBuild.create({ data: { agentId: job.id, version: 1, status: 'promoted', planHash: 'p1' } });
    await prisma.toolSample.create({ data: { agentId: job.id, service: 'instagram', action: 'search_hashtag', actionId: 'svc:instagram.search_hashtag', argsHash: 'h1', arguments: '{}', payload: Buffer.from('x'), bytes: 1 } });
    await prisma.jobRunLock.create({ data: { jobId: job.id, holder: 'h1', runId: run.id, expiresAt: new Date(Date.now() + 60_000) } });
    // A one-time can't-undo decision this run held (BEA-1401) — keyed on the run, no FK, so it was
    // the one table the delete missed.
    await prisma.serviceGate.create({ data: { service: 'github', action: 'svc:github.delete_a_repository', scope: 'once', runId: run.id, nodeId: 'worker:3', decision: 'approved' } });
    const flow = await prisma.flow.create({ data: { agentId: job.id, name, graph: '{}' } });
    await prisma.flowRun.create({ data: { flowId: flow.id, status: 'done' } });
    return { job, run, flow };
  }

  it('sweeps the runs, the journal, the waitpoints, the lock, the builds, the samples, the watch, the gates and the flows', async () => {
    const { job, run } = await jobWithEverything();
    const removed: string[] = [];
    agents.setWorkerCleanup(async (jobId: string) => { removed.push(jobId); });
    // The owner's own permanent release of a gate, made in /tools. It belongs to the SERVICE, not to
    // this job, and deleting a job may never quietly turn a confirmation back on (BEA-1401).
    await prisma.serviceGate.create({ data: { service: 'github', action: 'svc:github.delete_a_repository', scope: 'always', decision: 'approved' } });

    await agents.deleteAgent(job.id);

    expect(await prisma.agent.count({ where: { id: job.id } })).toBe(0);
    expect(await prisma.agentRun.count({ where: { agentId: job.id } })).toBe(0);
    expect(await prisma.runJournal.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.waitpoint.count({ where: { runId: run.id } })).toBe(0);
    expect(await prisma.jobRunLock.count({ where: { jobId: job.id } })).toBe(0);
    expect(await prisma.workerBuild.count({ where: { agentId: job.id } })).toBe(0);
    expect(await prisma.toolSample.count({ where: { agentId: job.id } })).toBe(0);
    expect(await prisma.socialWatch.count({ where: { agentId: job.id } })).toBe(0);
    expect(await prisma.flow.count({ where: { agentId: job.id } })).toBe(0);
    expect(await prisma.flowRun.count({})).toBe(0);
    expect(await prisma.serviceGate.count({ where: { runId: run.id } })).toBe(0);
    // …but the permanent release is untouched: it is a setting about a service, not a job's row.
    expect(await prisma.serviceGate.count({ where: { scope: 'always' } })).toBe(1);
    await prisma.serviceGate.deleteMany({ where: { scope: 'always' } });
    // …and the version folders on the host, which are the runner's to remove.
    expect(removed).toEqual([job.id]);
  });

  it('touches nothing that belongs to another job', async () => {
    const mine = await jobWithEverything('Mine');
    const yours = await jobWithEverything('Yours');
    agents.setWorkerCleanup(null);

    await agents.deleteAgent(mine.job.id);

    expect(await prisma.agent.count({ where: { id: yours.job.id } })).toBe(1);
    expect(await prisma.runJournal.count({ where: { runId: yours.run.id } })).toBe(1);
    expect(await prisma.waitpoint.count({ where: { runId: yours.run.id } })).toBe(1);
    expect(await prisma.workerBuild.count({ where: { agentId: yours.job.id } })).toBe(1);
    expect(await prisma.toolSample.count({ where: { agentId: yours.job.id } })).toBe(1);
    expect(await prisma.jobRunLock.count({ where: { jobId: yours.job.id } })).toBe(1);
    expect(await prisma.serviceGate.count({ where: { runId: yours.run.id } })).toBe(1);
    await agents.deleteAgent(yours.job.id);
  });

  it('a worker runner that cannot be reached does not stop the delete', async () => {
    const { job } = await jobWithEverything('Runner down');
    agents.setWorkerCleanup(async () => { throw new Error('the worker runner could not be reached'); });
    await expect(agents.deleteAgent(job.id)).resolves.toEqual({ ok: true });
    expect(await prisma.agent.count({ where: { id: job.id } })).toBe(0);
    agents.setWorkerCleanup(null);
  });

  it('keeps the credit ledger: a deleted job does not rewrite what was already spent', async () => {
    // `ToolCall` is what the daily Social ceiling is summed from. Deleting yesterday's spend because
    // a job was deleted would make the ceiling lie, so those rows stay on purpose.
    const { job, run } = await jobWithEverything('Spender');
    await prisma.toolCall.create({ data: { runId: run.id, agentId: job.id, service: 'instagram', action: 'svc:instagram.search_hashtag', ok: true, credits: 4 } });
    await agents.deleteAgent(job.id);
    expect(await prisma.toolCall.count({ where: { agentId: job.id } })).toBe(1);
    await prisma.toolCall.deleteMany({});
  });
});

describe('What one run cost (BEA-1394 §I)', () => {
  it('sums the credits of this run only, and counts the AI tokens the roads added', async () => {
    const job = await prisma.agent.create({ data: { name: 'Costed', prompt: 'go' } });
    const run = await prisma.agentRun.create({ data: { agentId: job.id, title: 'Costed', status: 'running' } });
    const other = await prisma.agentRun.create({ data: { agentId: job.id, title: 'Another', status: 'running' } });
    const call = (runId: string, credits: number) => prisma.toolCall.create({ data: { runId, agentId: job.id, service: 'instagram', action: 'svc:instagram.search_hashtag', ok: true, credits } });
    await call(run.id, 3);
    await call(run.id, 0); // a cache hit is still a call, and saying so is how "0 credits" reads
    await call(other.id, 99);

    await agents.addAiTokens(run.id, 12_000);
    await agents.addAiTokens(run.id, 500);
    await agents.addAiTokens(run.id, 0); // nothing to add is never an update

    expect(await agents.runCost(run.id)).toEqual({ credits: 3, aiTokens: 12_500, calls: 2 });
    const shown = await agents.getRun(run.id);
    expect(shown.cost).toEqual({ credits: 3, aiTokens: 12_500, calls: 2 });
    // A run that spent nothing says exactly that, rather than nothing at all.
    const idle = await prisma.agentRun.create({ data: { agentId: job.id, title: 'Idle', status: 'done' } });
    expect(await agents.runCost(idle.id)).toEqual({ credits: 0, aiTokens: 0, calls: 0 });
  });
});
