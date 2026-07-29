import { FlowRunnerService } from './flows-runner.service';

/**
 * BEA-1192 — a branch does dozens of searches over several minutes and NONE of it reached the flow.
 * The flow logged "started" and then nothing until everything finished, so a healthy five-minute run
 * was indistinguishable from a broken one — which is exactly how one came to be reported as stuck.
 */
function svc(stepLogs: any[][]) {
  let call = 0;
  const prisma: any = {
    agentRun: { findUnique: async () => ({ stepLog: JSON.stringify(stepLogs[Math.min(call++, stepLogs.length - 1)]) }) },
  };
  return new FlowRunnerService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('a running flow shows what it is doing (BEA-1192)', () => {
  it('mirrors the branch\'s real steps into the flow, and never repeats one', async () => {
    const lines: string[] = [];
    const s: any = svc([
      [{ label: '🌐 Searched: placements 2026' }, { label: '🌐 Searched: COEP stats' }],
      [{ label: '🌐 Searched: placements 2026' }, { label: '🌐 Searched: COEP stats' }, { label: '💬 wrote the answer' }],
    ]);
    const stop = s.mirrorSteps('run-1', (t: string) => lines.push(t));
    await new Promise((r) => setTimeout(r, 4300));
    await new Promise((r) => setTimeout(r, 4300));
    stop();
    expect(lines.some((l) => l.includes('placements 2026'))).toBe(true);
    expect(lines.some((l) => l.includes('wrote the answer'))).toBe(true);
    // each step appears once, however many times it is polled
    expect(lines.filter((l) => l.includes('COEP stats')).length).toBe(1);
  }, 15000);

  it('does nothing at all when there is nowhere to write', () => {
    const s: any = svc([[]]);
    const stop = s.mirrorSteps('run-1', undefined);
    expect(typeof stop).toBe('function');
    stop(); // must not throw
  });

  it('says a branch is waiting when the engine is already busy', async () => {
    const lines: string[] = [];
    const s: any = svc([[]]);
    s.engineQueued = 1; // another branch holds the engine
    s.agent = { createRun: async () => ({ id: 'r1' }), getRun: async () => ({ status: 'done', resultText: 'x' }) };
    s.bridge = { execute: async () => undefined };
    await s.agentRun('p', 'Branch 2', null, (t: string) => lines.push(t));
    expect(lines[0]).toContain('waiting its turn');
    expect(lines.some((l) => l.includes('working'))).toBe(true);
  }, 15000);
});
