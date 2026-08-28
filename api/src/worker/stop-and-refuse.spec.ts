import { AgentService } from '../agent/agent.service';
import { isGoalBuilt } from './worker-dispatch.service';

/**
 * Stopping means stopped, and a job that cannot fall back does not (BEA-1541).
 *
 * Two failures, both seen live on his "Searches all of Reddit for ESP32" agent:
 *
 * 1. **Cancel was bookkeeping.** It marked the run `cancelled`, freed the lock and dropped the
 *    journal — and the worker carried on to the end still holding a valid token, so a cancelled run
 *    could keep spending credits, writing to his Google Sheet and sending WhatsApp messages. There
 *    was no Stop button anywhere, and the host runner had no `/stop` route to call even if there had
 *    been one.
 *
 * 2. **The engine fallback ran a build instruction.** The agent's worker was still being compiled, so
 *    the road fell back to the engine — which was handed "Build a manually run agent that searches
 *    all of Reddit…" with no tools, spent three minutes, and produced nothing.
 */
describe('cancel actually stops the work', () => {
  function svc() {
    const calls: string[] = [];
    const run = { id: 'r1', agentId: 'a1', status: 'running', runKind: 'worker', stepLog: '[]' };
    const prisma: any = {
      agentRun: {
        findUnique: async () => ({ ...run }),
        update: async ({ data }: any) => { calls.push(`row:${data.status}`); return { ...run, ...data }; },
      },
      waitpoint: { updateMany: async () => { calls.push('waitpoints'); return { count: 0 }; } },
    };
    const s: any = new (AgentService as any)(prisma);
    s.shapeRun = (r: any) => r;
    s.locks = { releaseForRun: async () => { calls.push('lock'); } };
    return { s, calls };
  }

  it('stops the work BEFORE it writes the run off', async () => {
    const { s, calls } = svc();
    s.setRunStopper(async () => { calls.push('STOPPED'); });
    await s.cancelRun('r1');
    // Order matters: every millisecond between "cancelled" and "keys revoked" is a millisecond the
    // worker can still write to his sheet or message someone.
    expect(calls.indexOf('STOPPED')).toBeLessThan(calls.indexOf('row:cancelled'));
  });

  it('still cancels when the host cannot be reached', async () => {
    const { s, calls } = svc();
    s.setRunStopper(async () => { throw new Error('runner is down'); });
    await expect(s.cancelRun('r1')).resolves.toBeTruthy();
    expect(calls).toContain('row:cancelled');   // a dead runner must never make a run un-cancellable
  });

  it('cancels normally when nothing registered a stopper', async () => {
    const { s, calls } = svc();
    await expect(s.cancelRun('r1')).resolves.toBeTruthy();
    expect(calls).toContain('row:cancelled');
  });
});

describe('a job that cannot fall back refuses instead', () => {
  it('knows which jobs are goal-built', () => {
    expect(isGoalBuilt({ origin: 'goal' })).toBe(true);
    expect(isGoalBuilt({ origin: 'social' })).toBe(false);
    expect(isGoalBuilt({})).toBe(false);
    expect(isGoalBuilt(null)).toBe(false);
  });

  // A Social job HAS a fallback — the plan runner does the whole job without a worker — so it must
  // keep falling back exactly as before. Refusing those would break jobs that work today.
  it('leaves the roads that can fall back alone', () => {
    expect(isGoalBuilt({ origin: 'social' })).toBe(false);
  });
});

describe('the wiring is actually connected', () => {
  const read = (f: string) => require('fs').readFileSync(__dirname + '/' + f, 'utf8');

  it('cancel calls the stopper', () => {
    expect(require('fs').readFileSync(__dirname + '/../agent/agent.service.ts', 'utf8'))
      .toMatch(/this\.runStopper\?\.\(id\)/);
  });

  it('the stopper revokes the keys and asks the host to kill it', () => {
    const s = read('worker-dispatch.service.ts');
    expect(s).toMatch(/setRunStopper/);
    expect(s).toMatch(/revokeRun\(runId\)/);
    expect(s).toMatch(/this\.runner\.stop\(runId\)/);
  });

  // Revoking is local and instant; killing needs a reachable host. If the order were reversed, an
  // unreachable runner would leave the worker holding working keys.
  it('revokes before it tries to kill', () => {
    const s = read('worker-dispatch.service.ts');
    expect(s.indexOf('revokeRun(runId)')).toBeLessThan(s.indexOf('this.runner.stop(runId)'));
  });

  it('the runner client has a stop that never throws', () => {
    const s = read('worker-runner.client.ts');
    expect(s).toMatch(/async stop\(runId: string\)/);
    expect(s).toMatch(/catch \(e: any\) \{[\s\S]{0,200}could not be stopped/);
  });

  it('a stuck build is marked failed rather than left building for ever', () => {
    const s = read('worker-build.service.ts');
    expect(s).toMatch(/async failStuckBuilds\(\)/);
    expect(s).toMatch(/status: 'failed'/);
    expect(s).toMatch(/stopped part-way through/);
  });

  it('the run road refuses rather than running the old way', () => {
    const s = require('fs').readFileSync(__dirname + '/../hermes/hermes-bridge.service.ts', 'utf8');
    expect(s).toMatch(/decision\?\.refuse/);
    // and it must stop BEFORE the engine is asked to do anything
    expect(s.indexOf('decision?.refuse')).toBeLessThan(s.lastIndexOf('await this.execute(runId, input)'));
  });
});
