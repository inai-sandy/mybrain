import { AgentService } from './agent.service';

/**
 * A job the SYSTEM switched off comes back on when a run of it succeeds — and a job HE switched off
 * never does (BEA-1514).
 *
 * The live failure this locks down: his ESP32 agent paused itself at 18:43 after ONE network failure
 * (the IPv6 timeout fixed hours later). It then ran green three times — 84 posts, sheet written — and
 * was still `enabled: false` with "its worker keeps failing (a call was refused on svc:reddit.subreddit)
 * and 2 repairs did not fix it" on its page. Nothing in the API ever cleared `pausedReason`; only his
 * own tap on "Switch back on" did. A weekly schedule would simply never have fired again.
 *
 * The whole safety of this rests on one existing fact, so it is asserted here rather than assumed:
 * `updateAgent` writes `pausedReason` ONLY when switching a job on (to null). A self-pause is the only
 * thing that ever writes a reason, so "has a reason" IS "the system did this", and the system may
 * clear only its own.
 */

type Job = { id: string; enabled: boolean; pausedReason: string | null };

function harness(job: Job, runStatus: 'done' | 'failed' | 'cancelled' = 'done') {
  const steps: any[] = [];
  const updates: any[] = [];
  const run = { id: 'r1', agentId: job.id, status: 'running', runKind: 'worker', stepLog: '[]', error: null };
  const prisma: any = {
    agentRun: {
      findUnique: async () => ({ ...run }),
      update: async ({ data }: any) => ({ ...run, ...data }),
    },
    waitpoint: { updateMany: async () => ({ count: 0 }) },
    agent: {
      findUnique: async ({ select }: any) => (select ? { enabled: job.enabled, pausedReason: job.pausedReason } : { ...job }),
      update: async ({ data }: any) => {
        updates.push(data);
        Object.assign(job, data);
        return { ...job };
      },
    },
  };
  const svc: any = new (AgentService as any)(prisma);
  svc.appendStep = async (_runId: string, step: any) => { steps.push(step); return {}; };
  svc.shapeRun = (r: any) => r;
  svc.parse = (s: any, d: any) => d;
  return { svc, steps, updates, finish: () => svc.finishRun('r1', { status: runStatus }) };
}

describe('a self-paused job comes back on when it works again (BEA-1514)', () => {
  it('switches a system-paused job back on after a successful run', async () => {
    const job: Job = { id: 'a1', enabled: false, pausedReason: 'Its worker keeps failing … and 2 repairs did not fix it.' };
    const h = harness(job);
    await h.finish();
    expect(job.enabled).toBe(true);
    expect(job.pausedReason).toBeNull();
    expect(h.updates).toEqual([{ enabled: true, pausedReason: null }]);
  });

  it('says so on the run, and says what it was off for', async () => {
    const job: Job = { id: 'a1', enabled: false, pausedReason: 'over the daily credit ceiling' };
    const h = harness(job);
    await h.finish();
    const said = h.steps.map((s) => `${s.label} ${s.detail || ''}`).join(' | ');
    expect(said).toContain('Switched back on');
    expect(said).toContain('over the daily credit ceiling');
  });

  // The one that makes this safe: HE switched it off, so it stays off however well the run went.
  it('never touches a job the owner switched off by hand (no reason on it)', async () => {
    const job: Job = { id: 'a1', enabled: false, pausedReason: null };
    const h = harness(job);
    await h.finish();
    expect(job.enabled).toBe(false);
    expect(h.updates).toEqual([]);
    expect(h.steps.map((s) => s.label).join(' ')).not.toContain('Switched back on');
  });

  it('leaves a job that is already on alone', async () => {
    const job: Job = { id: 'a1', enabled: true, pausedReason: null };
    const h = harness(job);
    await h.finish();
    expect(h.updates).toEqual([]);
  });

  for (const status of ['failed', 'cancelled'] as const) {
    it(`does not switch anything on when the run ${status}`, async () => {
      const job: Job = { id: 'a1', enabled: false, pausedReason: 'its worker keeps failing' };
      const h = harness(job, status);
      await h.finish();
      expect(job.enabled).toBe(false);
      expect(h.updates).toEqual([]);
    });
  }

  it('a finish still succeeds when the agent row cannot be read', async () => {
    const job: Job = { id: 'a1', enabled: false, pausedReason: 'boom' };
    const h = harness(job);
    (h.svc as any).prisma.agent.findUnique = async () => { throw new Error('database gone'); };
    await expect(h.finish()).resolves.toBeTruthy();
  });

  // `pausedReason` is the marker the rule above depends on. If a future change starts writing one on
  // an ordinary edit, "the system paused this" stops being true and a job he switched off would come
  // back on by itself. This reads the source so that change cannot pass unnoticed.
  it('only a self-pause ever writes a pausedReason', () => {
    const src = require('fs').readFileSync(__dirname + '/agent.service.ts', 'utf8');
    // `null` clears it; `true` is a Prisma `select`. Anything else here would be this file setting a
    // reason of its own, which is the thing that must never happen.
    const writes = (src.match(/pausedReason:\s*[^,\n}]+/g) || []).map((w: string) => w.trim());
    const sets = writes.filter((w: string) => !/pausedReason:\s*(null|true)$/.test(w));
    expect(sets).toEqual([]);
  });
});
