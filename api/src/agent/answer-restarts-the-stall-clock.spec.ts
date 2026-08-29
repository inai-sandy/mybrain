import { AgentService } from './agent.service';
import { lastActivityAt, STALL_MINUTES } from '../worker/worker-sweeper.service';

/**
 * A run waiting for his answer is not a stalled run (BEA-1565).
 *
 * His words, 2026-08-29: *"and recent run also failed"*. It had not failed. Run `9f5a84d7` did the
 * whole job — 242 Reddit posts over 36 pages, a verified 100-row Google Sheet, the WhatsApp sent —
 * all by 19:58:05. Then it asked whether the message had arrived, and parked. He answered at
 * 03:00:39. The run was dead within seconds, marked *"stopped making progress — nothing was written
 * for 20 minutes"*.
 *
 * The mechanism: the stall watchdog measures `lastActivityAt()`, the newest STEP's timestamp. While
 * the run was parked nothing was written — by definition, because it was waiting for a human. So
 * the moment his answer flipped the row from `awaiting_input` back to `running`, the sweeper saw a
 * run whose last activity was seven hours ago and failed it on the next tick. The worker was never
 * even given the chance to respawn.
 *
 * We built a pause that can wait days and then put a 20-minute timer over it.
 *
 * The fix is that the answer IS activity: `resolve()` appends a step when it revives a parked run,
 * which restarts the clock and tells him on the run screen that his answer landed.
 */

function fakePrisma() {
  const runs: any[] = [];
  const wps: any[] = [];
  return {
    _runs: runs,
    _wps: wps,
    agentRun: {
      findUnique: async ({ where }: any) => runs.find((r) => r.id === where.id) || null,
      findFirst: async ({ where }: any) => runs.find((r) => r.id === where?.id) || null,
      update: async ({ where, data }: any) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) throw new Error('not found');
        Object.assign(r, data);
        return r;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = runs.filter((r) => r.id === where.id && (!where.status?.in || where.status.in.includes(r.status)));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
    },
    waitpoint: {
      findUnique: async ({ where }: any) => wps.find((w) => w.id === where.id) || null,
      findFirst: async ({ where }: any) => wps.find((w) => w.id === where.id) || null,
      updateMany: async ({ where, data }: any) => {
        const hit = wps.filter((w) => w.id === where.id && (where.status === undefined || w.status === where.status));
        for (const w of hit) Object.assign(w, data);
        return { count: hit.length };
      },
    },
  };
}

/** The exact shape of his run: everything done, then parked on a question hours ago. */
function parkedRun(prisma: any, askedAt: Date) {
  prisma._runs.push({
    id: 'run-1',
    agentId: 'a-1',
    title: 'ESP32 weekly top posts',
    status: 'awaiting_input',
    startedAt: new Date(askedAt.getTime() - 5 * 60_000),
    stepLog: JSON.stringify([
      { label: 'Fetched Reddit · Search — 242 items over 36 pages', status: 'done', at: new Date(askedAt.getTime() - 60_000).toISOString() },
      { label: 'Created the sheet and wrote 100 posts', status: 'done', at: new Date(askedAt.getTime() - 20_000).toISOString() },
      { label: 'Waiting for you: did you receive the message?', status: 'running', at: askedAt.toISOString() },
    ]),
  });
  prisma._wps.push({ id: 'wp-1', runId: 'run-1', status: 'pending', kind: 'choice', question: 'Did you receive it?', options: null, expiresAt: null });
}

describe('answering a parked run restarts the stall clock', () => {
  const ASKED = new Date('2026-08-28T19:58:05Z');
  const ANSWERED = new Date('2026-08-29T03:00:39Z'); // his real gap: seven hours

  it('reproduces the bug: without a step, the revived run is already stale', () => {
    // The run as it was at the moment his answer flipped it back to `running` — the old behaviour.
    const run = { startedAt: ASKED, stepLog: JSON.stringify([{ label: 'asked', at: ASKED.toISOString() }]) };
    const cutoff = ANSWERED.getTime() - STALL_MINUTES * 60_000;
    // This is the sweeper's own test, and it says "kill it" — seven hours with nothing written.
    expect(lastActivityAt(run as any)).toBeLessThan(cutoff);
  });

  it('writes a step when the answer revives the run, so the clock starts again', async () => {
    const prisma = fakePrisma();
    parkedRun(prisma, ASKED);
    const svc = new AgentService(prisma as any);

    await svc.answerById('wp-1', 'I received it');

    const run = prisma._runs[0];
    expect(run.status).toBe('running');
    const log = JSON.parse(run.stepLog);
    const last = log[log.length - 1];
    expect(last.label).toMatch(/answer arrived/i);
    expect(last.detail).toMatch(/I received it/);

    // The whole point: measured by the sweeper's OWN function, the run is now fresh, so the tick
    // that used to kill it on the spot leaves it alone.
    const cutoff = Date.now() - STALL_MINUTES * 60_000;
    expect(lastActivityAt(run)).toBeGreaterThan(cutoff);
  });

  /**
   * BEA-794 must survive: answering a run that already finished is a no-op. Flipping a terminal run
   * back to `running` leaves it stuck forever with no driver, so no step may be written either —
   * a step on a finished run is a lie about it still working.
   */
  it('writes nothing when the run already finished', async () => {
    const prisma = fakePrisma();
    parkedRun(prisma, ASKED);
    prisma._runs[0].status = 'failed';
    const before = prisma._runs[0].stepLog;
    const svc = new AgentService(prisma as any);

    await svc.answerById('wp-1', 'too late');

    expect(prisma._runs[0].status).toBe('failed');
    expect(prisma._runs[0].stepLog).toBe(before);
  });

  // Answering twice must not append twice — the second answer never revives anything.
  it('writes the step once, however many times the answer is sent', async () => {
    const prisma = fakePrisma();
    parkedRun(prisma, ASKED);
    const svc = new AgentService(prisma as any);

    await svc.answerById('wp-1', 'I received it');
    await svc.answerById('wp-1', 'I received it');

    const arrivals = JSON.parse(prisma._runs[0].stepLog).filter((s: any) => /answer arrived/i.test(s.label || ''));
    expect(arrivals).toHaveLength(1);
  });
});
