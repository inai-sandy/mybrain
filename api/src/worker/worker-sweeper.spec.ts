import { WorkerSweeperService, STALL_MINUTES, lastActivityAt } from './worker-sweeper.service';

/**
 * The worker road's own sweeper (BEA-1392 §H): resume, the deadline, the stall watchdog — and the
 * rule that a late answer must not make yesterday's run write today's rows a second time.
 */

const MIN = 60_000;
const ago = (mins: number) => new Date(Date.now() - mins * MIN);

function world(rows: { runs?: any[]; waitpoints?: any[] } = {}) {
  const runs: any[] = rows.runs || [];
  const waitpoints: any[] = rows.waitpoints || [];
  const steps: any[] = [];
  const finished: any[] = [];
  const told: any[] = [];
  const spawned: any[] = [];
  const parked: any[] = [];
  const released: string[] = [];

  const matches = (row: any, where: any): boolean =>
    Object.entries(where || {}).every(([k, v]: any) => {
      if (k === 'NOT') return !matches(row, v);
      if (k === 'run') return matches(row.run || {}, v);
      if (k === 'waitpoints') return (waitpoints.filter((w) => w.runId === row.id)).some((w) => matches(w, v.some));
      const val = row[k];
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        // Every operator on the field has to hold — `{ not: null, lte: now }` means BOTH.
        if ('in' in v && !v.in.includes(val)) return false;
        if ('not' in v && (val === v.not || (v.not === null && val == null))) return false;
        if ('lte' in v && !(val != null && new Date(val).getTime() <= new Date(v.lte).getTime())) return false;
        if ('gt' in v && !(val != null && new Date(val).getTime() > new Date(v.gt).getTime())) return false;
        return true;
      }
      return val === v;
    });

  const prisma: any = {
    agentRun: {
      findMany: async ({ where }: any) => runs.filter((r) => matches(r, where)),
      findFirst: async ({ where }: any) => runs.filter((r) => matches(r, where))[0] || null,
    },
    waitpoint: {
      findMany: async ({ where }: any) => waitpoints.filter((w) => matches({ ...w, run: runs.find((r) => r.id === w.runId) }, where)).map((w) => ({ ...w, run: runs.find((r) => r.id === w.runId) })),
    },
  };
  const agent: any = {
    claimResume: async (id: string) => {
      const run = runs.find((r) => r.id === id);
      if (!run || run.sessionId == null) return false;
      run.sessionId = null;
      return true;
    },
    parkRun: async (id: string, sessionId: string) => { parked.push(id); const r = runs.find((x) => x.id === id); if (r) r.sessionId = sessionId; },
    appendStep: async (runId: string, s: any) => { steps.push({ runId, ...s }); },
    finishRun: async (runId: string, p: any) => { finished.push({ runId, ...p }); const r = runs.find((x) => x.id === runId); if (r) r.status = p.status; return r; },
    expireAsk: async (id: string) => { const w = waitpoints.find((x) => x.id === id); if (!w || w.status !== 'pending') return false; w.status = 'expired'; return true; },
  };
  const progress: any[] = [];
  agent.stampProgress = async (runId: string, label: string) => { progress.push({ runId, label }); };
  const tokens: any = {
    busy: false,
    mint: async (runId: string) => {
      if (tokens.busy) { const e: any = new Error('This job is already running.'); e.name = 'JobBusyError'; throw e; }
      return { token: `t-${runId}`, seed: { now: 1, random: 1 } };
    },
    revokeRun: () => 0,
  };
  const runner: any = { run: async (input: any) => { spawned.push(input); return runner.answer; }, answer: { status: 'done', rows: 2 } };
  const alerts: any = { runFailed: async (name: string, reason: string) => { told.push({ name, reason }); return { sent: true }; } };
  const locks: any = { releaseForRun: async (id: string) => { released.push(id); return true; } };

  const sweeper = new WorkerSweeperService(prisma, agent, tokens, runner, alerts, locks);
  return { sweeper, runs, waitpoints, steps, finished, told, spawned, parked, released, runner, tokens, progress };
}

const parkedRun = (over: any = {}) => ({ id: 'run1', agentId: 'ag1', title: 'Smart Home Instagram', status: 'running', runKind: 'worker', sessionId: 'worker', startedAt: ago(60), stepLog: '[]', ...over });

describe('resuming a parked worker run', () => {
  it('spawns it again once the question is answered, with a fresh token', async () => {
    const w = world({ runs: [parkedRun()], waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }] });
    expect(await w.sweeper.resumeAnswered()).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.spawned).toHaveLength(1);
    expect(w.spawned[0]).toMatchObject({ jobId: 'ag1', runId: 'run1', token: 't-run1' });
  });

  it('an unanswered question is left alone — the run stays parked', async () => {
    const w = world({ runs: [parkedRun()], waitpoints: [{ id: 'wp1', runId: 'run1', status: 'pending' }] });
    expect(await w.sweeper.resumeAnswered()).toBe(0);
    expect(w.spawned).toHaveLength(0);
  });

  it('two ticks can never spawn the same run twice', async () => {
    const w = world({ runs: [parkedRun()], waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }] });
    await Promise.all([w.sweeper.resumeAnswered(), w.sweeper.resumeAnswered()]);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.spawned).toHaveLength(1);
  });

  it('a worker that cannot be started fails the run honestly and tells the owner', async () => {
    const w = world({ runs: [parkedRun()], waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }] });
    w.runner.answer = { status: 'failed', error: 'No worker is installed for this job yet.' };
    await w.sweeper.resumeAnswered();
    await new Promise((r) => setTimeout(r, 5));
    expect(w.finished[0]).toMatchObject({ runId: 'run1', status: 'failed' });
    expect(w.told[0].reason).toContain('No worker is installed');
  });

  it('a job that is busy right now is retried, not failed — and it counts as moving', async () => {
    const w = world({ runs: [parkedRun()], waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }] });
    w.tokens.busy = true;
    await w.sweeper.resumeAnswered();
    await new Promise((r) => setTimeout(r, 5));
    expect(w.spawned).toHaveLength(0);
    expect(w.finished).toHaveLength(0);
    expect(w.parked).toEqual(['run1']); // parked again, so the next tick picks it straight back up
    // Without this line the stall watchdog would fail a run that is only waiting its turn.
    expect(w.progress[0].label).toContain('another run of this job is still going');
  });

  it('a worker that parked AGAIN is simply left waiting', async () => {
    const w = world({ runs: [parkedRun()], waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }] });
    w.runner.answer = { status: 'waiting', waitpointId: 'wp2' };
    await w.sweeper.resumeAnswered();
    await new Promise((r) => setTimeout(r, 5));
    expect(w.finished).toHaveLength(0);
  });
});

describe('a late answer must not redo what a newer run already did', () => {
  it('finishes honestly, writing no rows, appending to no sheet, sending no message', async () => {
    // The exact sequence: the run parks on a question · its 30-minute lock expires · the next
    // scheduled run of the same job starts and FINISHES · only then does he answer.
    const w = world({
      runs: [
        parkedRun({ startedAt: ago(600) }),
        { id: 'run2', agentId: 'ag1', status: 'done', runKind: 'worker', startedAt: ago(120), endedAt: ago(110), stepLog: '[]' },
      ],
      waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }],
    });
    expect(await w.sweeper.resumeAnswered()).toBe(0);
    await new Promise((r) => setTimeout(r, 5));

    expect(w.spawned).toHaveLength(0); // nothing ran at all — no rows, no sheet, no message
    expect(w.finished[0]).toMatchObject({ runId: 'run1', status: 'done' });
    expect(w.finished[0].resultText).toContain('A newer run of this job already did this');
    expect(w.finished[0].resultText).toContain('too late');
    expect(w.steps[0].label).toContain('a newer run already did this');
  });

  it('a newer run that FAILED does not count — the answer is still worth having', async () => {
    const w = world({
      runs: [
        parkedRun({ startedAt: ago(600) }),
        { id: 'run2', agentId: 'ag1', status: 'failed', runKind: 'worker', startedAt: ago(120), endedAt: ago(110), stepLog: '[]' },
      ],
      waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }],
    });
    expect(await w.sweeper.resumeAnswered()).toBe(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.spawned).toHaveLength(1);
  });

  it('a run of ANOTHER job is not "newer" — it is nothing to do with this one', async () => {
    const w = world({
      runs: [
        parkedRun({ startedAt: ago(600) }),
        { id: 'run2', agentId: 'ag2', status: 'done', runKind: 'worker', startedAt: ago(120), endedAt: ago(110), stepLog: '[]' },
      ],
      waitpoints: [{ id: 'wp1', runId: 'run1', status: 'answered' }],
    });
    expect(await w.sweeper.resumeAnswered()).toBe(1);
  });
});

describe('the 12-hour deadline', () => {
  it('a question that ran out of time with no default stops the run honestly', async () => {
    const w = world({
      runs: [parkedRun({ status: 'awaiting_input' })],
      waitpoints: [{ id: 'wp1', runId: 'run1', status: 'pending', question: 'Which sheet should these go in?', defaultValue: null, expiresAt: ago(1), createdAt: ago(12 * 60) }],
    });
    expect(await w.sweeper.sweepDeadlines()).toBe(1);
    expect(w.waitpoints[0].status).toBe('expired');
    expect(w.finished[0]).toMatchObject({ runId: 'run1', status: 'failed' });
    expect(w.finished[0].error).toContain('named no default');
    expect(w.told).toHaveLength(1);
  });

  it('a question that is not due yet is left alone', async () => {
    const w = world({
      runs: [parkedRun({ status: 'awaiting_input' })],
      waitpoints: [{ id: 'wp1', runId: 'run1', status: 'pending', question: 'q', defaultValue: null, expiresAt: new Date(Date.now() + 60 * MIN), createdAt: ago(60) }],
    });
    expect(await w.sweeper.sweepDeadlines()).toBe(0);
    expect(w.finished).toHaveLength(0);
  });

  it('a question WITH a default is not this sweep\'s business — the app applies it as an answer', async () => {
    const w = world({
      runs: [parkedRun({ status: 'awaiting_input' })],
      waitpoints: [{ id: 'wp1', runId: 'run1', status: 'pending', question: 'q', defaultValue: 'Carry on', expiresAt: ago(1), createdAt: ago(12 * 60) }],
    });
    expect(await w.sweeper.sweepDeadlines()).toBe(0);
    expect(w.waitpoints[0].status).toBe('pending');
  });

  it('sweeping twice reports and fails it exactly once', async () => {
    const w = world({
      runs: [parkedRun({ status: 'awaiting_input' })],
      waitpoints: [{ id: 'wp1', runId: 'run1', status: 'pending', question: 'q', defaultValue: null, expiresAt: ago(1), createdAt: ago(12 * 60) }],
    });
    await w.sweeper.sweepDeadlines();
    await w.sweeper.sweepDeadlines();
    expect(w.finished).toHaveLength(1);
    expect(w.told).toHaveLength(1);
  });
});

describe('the stall watchdog — both roads', () => {
  it('fails a run that has written nothing for STALL_MINUTES, tells the owner and frees the job', async () => {
    const w = world({ runs: [{ id: 'run1', agentId: 'ag1', title: 'Smart Home Instagram', status: 'running', runKind: 'worker', sessionId: null, startedAt: ago(STALL_MINUTES + 5), stepLog: '[]' }] });
    expect(await w.sweeper.sweepStalls()).toBe(1);
    expect(w.finished[0]).toMatchObject({ runId: 'run1', status: 'failed' });
    expect(w.finished[0].error).toContain('stopped making progress');
    expect(w.steps[0].label).toBe('Stopped making progress — nothing was written');
    expect(w.told).toHaveLength(1);
    expect(w.released).toEqual(['run1']);
  });

  it('covers the plan runner too — the road the 20-hour zombie was on', async () => {
    const w = world({ runs: [{ id: 'runP', agentId: 'ag1', status: 'running', runKind: 'plan', startedAt: ago(20 * 60), stepLog: '[]' }] });
    expect(await w.sweeper.sweepStalls()).toBe(1);
  });

  it('never fires on a legitimately slow job — a checkpoint IS progress', async () => {
    const log = JSON.stringify([{ label: 'fetching Instagram — page 7 of 11', status: 'running', kind: 'checkpoint', at: ago(2).toISOString() }]);
    const w = world({ runs: [{ id: 'run1', agentId: 'ag1', status: 'running', runKind: 'worker', startedAt: ago(3 * 60), stepLog: log }] });
    expect(await w.sweeper.sweepStalls()).toBe(0);
    expect(w.finished).toHaveLength(0);
  });

  it('leaves a parked run alone — waiting for an answer is not stalling', async () => {
    const w = world({ runs: [parkedRun({ status: 'awaiting_input', startedAt: ago(10 * 60) })] });
    expect(await w.sweeper.sweepStalls()).toBe(0);
  });

  it('leaves an ENGINE run alone — a Codex turn has its own watchdog and its own idea of slow', async () => {
    const w = world({ runs: [{ id: 'runE', agentId: 'ag1', status: 'running', runKind: 'engine', startedAt: ago(10 * 60), stepLog: '[]' }] });
    expect(await w.sweeper.sweepStalls()).toBe(0);
  });

  it('reads the last step or checkpoint as the moment of life', () => {
    const at = ago(5).toISOString();
    expect(lastActivityAt({ startedAt: ago(90), stepLog: JSON.stringify([{ at }]) })).toBe(new Date(at).getTime());
    expect(lastActivityAt({ startedAt: ago(90), stepLog: 'not json' })).toBe(ago(90).getTime());
  });
});
