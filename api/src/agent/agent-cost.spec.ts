import { AgentService } from './agent.service';

/**
 * What one agent has cost, over its life and over the last 30 days (BEA-1526).
 *
 * Summed from the SAME ledger `runCost` reads — `ToolCall.credits` — because that table is also what
 * the daily ceiling is summed from. A second way of counting credits would eventually disagree with
 * the per-run figure on the run screen and with the ceiling that pauses jobs, and there would be no
 * way to tell which was right.
 */
describe('agentCost (BEA-1526)', () => {
  const DAY = 24 * 3600_000;

  function svc(runs: any[], calls: any[], opts: { noLedger?: boolean } = {}) {
    const prisma: any = {
      agentRun: { findMany: async ({ where }: any) => runs.filter((r) => r.agentId === where.agentId) },
      toolCall: opts.noLedger ? undefined : { findMany: async ({ where }: any) => calls.filter((c) => where.runId.in.includes(c.runId)) },
    };
    return new (AgentService as any)(prisma);
  }

  const recent = new Date(Date.now() - 3 * DAY);
  const old = new Date(Date.now() - 200 * DAY);

  it('adds up credits, tokens and calls over the whole life', async () => {
    const s = svc(
      [
        { id: 'r1', agentId: 'a', aiTokens: 1000, startedAt: old },
        { id: 'r2', agentId: 'a', aiTokens: 2000, startedAt: recent },
      ],
      [
        { runId: 'r1', credits: 5 },
        { runId: 'r1', credits: 3 },
        { runId: 'r2', credits: 4 },
      ],
    );
    const c = await s.agentCost('a');
    expect(c.runs).toBe(2);
    expect(c.credits).toBe(12);
    expect(c.aiTokens).toBe(3000);
    expect(c.calls).toBe(3);
  });

  it('counts the last 30 days separately', async () => {
    const s = svc(
      [
        { id: 'r1', agentId: 'a', aiTokens: 1000, startedAt: old },
        { id: 'r2', agentId: 'a', aiTokens: 2000, startedAt: recent },
      ],
      [{ runId: 'r1', credits: 5 }, { runId: 'r2', credits: 4 }],
    );
    const c = await s.agentCost('a');
    expect(c.runs30d).toBe(1);
    expect(c.credits30d).toBe(4);   // r1's 5 are older than 30 days
    expect(c.aiTokens30d).toBe(2000);
  });

  it('never counts another agent\'s runs', async () => {
    const s = svc(
      [
        { id: 'r1', agentId: 'a', aiTokens: 10, startedAt: recent },
        { id: 'r2', agentId: 'b', aiTokens: 999, startedAt: recent },
      ],
      [{ runId: 'r1', credits: 1 }, { runId: 'r2', credits: 500 }],
    );
    const c = await s.agentCost('a');
    expect(c.runs).toBe(1);
    expect(c.credits).toBe(1);
    expect(c.aiTokens).toBe(10);
  });

  it('is all zeros for an agent that has never run', async () => {
    const c = await svc([], []).agentCost('a');
    expect(c).toEqual({ runs: 0, runs30d: 0, credits: 0, credits30d: 0, aiTokens: 0, aiTokens30d: 0, calls: 0, firstRunAt: null });
  });

  // A run that used only saved answers really did cost nothing. That is a fact to report, not a gap.
  it('reports runs with no ledger rows as having cost nothing', async () => {
    const s = svc([{ id: 'r1', agentId: 'a', aiTokens: 0, startedAt: recent }], []);
    const c = await s.agentCost('a');
    expect(c.runs).toBe(1);
    expect(c.credits).toBe(0);
    expect(c.calls).toBe(0);
  });

  it('degrades to zeros rather than throwing when there is no ledger table', async () => {
    const s = svc([{ id: 'r1', agentId: 'a', aiTokens: 50, startedAt: recent }], [], { noLedger: true });
    const c = await s.agentCost('a');
    expect(c.credits).toBe(0);
    expect(c.aiTokens).toBe(50); // the runs still count
  });

  it('reports when it first ran', async () => {
    const s = svc(
      [
        { id: 'r1', agentId: 'a', aiTokens: 0, startedAt: old },
        { id: 'r2', agentId: 'a', aiTokens: 0, startedAt: recent },
      ],
      [],
    );
    expect((await s.agentCost('a')).firstRunAt).toBe(old.toISOString());
  });

  /**
   * The first version sorted Date OBJECTS with a bare `.sort()`, which compares their `toString()`
   * forms — "Wed Aug 27 2026…" vs "Fri Aug 28 2026…" — and therefore orders by WEEKDAY NAME. It
   * shipped, and reported his agent's first run as today when it had plainly run the day before.
   *
   * These two dates are chosen so weekday order and real order DISAGREE: Wednesday 26 Aug came first,
   * but "Fri" sorts before "Wed". The old code returned the Friday.
   */
  it('orders by the real time, not the weekday name', async () => {
    const wed = new Date('2026-08-26T03:00:00.000Z'); // earlier, but "Wed" sorts last
    const fri = new Date('2026-08-28T03:00:00.000Z'); // later, but "Fri" sorts first
    const s = svc(
      [
        { id: 'r1', agentId: 'a', aiTokens: 0, startedAt: fri },
        { id: 'r2', agentId: 'a', aiTokens: 0, startedAt: wed },
      ],
      [],
    );
    expect((await s.agentCost('a')).firstRunAt).toBe(wed.toISOString());
  });

  it('survives a run row with no start time', async () => {
    const s = svc(
      [
        { id: 'r1', agentId: 'a', aiTokens: 0, startedAt: null },
        { id: 'r2', agentId: 'a', aiTokens: 0, startedAt: recent },
      ],
      [],
    );
    expect((await s.agentCost('a')).firstRunAt).toBe(recent.toISOString());
  });

  it('a broken query is an empty answer, never a failed page', async () => {
    const prisma: any = { agentRun: { findMany: async () => { throw new Error('database gone'); } } };
    const c = await new (AgentService as any)(prisma).agentCost('a');
    expect(c.runs).toBe(0);
  });
});
