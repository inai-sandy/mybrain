import { WorkerRepairService } from './worker-repair.service';

/**
 * His decision is not a defect (BEA-1546).
 *
 * His Reddit agent hit a wall, asked him on WhatsApp, and he answered "Stop this run". The worker's
 * own code ends that branch with `kit.fail('Stopped at your request; nothing further was sent.')` —
 * Codex writes it that way — so the run arrived at the repair loop looking exactly like a crash.
 *
 * The loop then spent a real Codex build repairing the sentence *"Stopped at your request"*. It
 * promoted v2, and v2 still calls Reddit with `sort: 'new'` — the actual defect — because the failure
 * it was handed described his button press, not the wall the worker hit.
 *
 * Detected from the RUN rather than the wording, so it holds however a worker phrases it.
 */
describe('a run the owner stopped is not repaired', () => {
  function svc(opts: { answeredAt?: Date | null; endedAt?: Date | null } = {}) {
    const calls: string[] = [];
    const prisma: any = {
      waitpoint: {
        findFirst: async () => (opts.answeredAt ? { answeredAt: opts.answeredAt } : null),
      },
      agentRun: { findUnique: async () => ({ endedAt: opts.endedAt ?? null }) },
      workerBuild: { findFirst: async () => null },
    };
    const s: any = new (WorkerRepairService as any)(prisma);
    s.log = { log: (m: string) => calls.push(m), warn: () => undefined };
    s.agent = { getAgent: async () => ({ id: 'a1' }) };
    s.evidenceOf = async () => { calls.push('evidence'); return []; };
    s.keepEvidence = async () => { calls.push('kept'); return []; };
    s.builds = { livePromoted: async () => { calls.push('WOULD REPAIR'); return { version: 1 }; } };
    s.attemptsFor = async () => 0;
    return { s, calls };
  }

  const at = (mins: number) => new Date(Date.now() - mins * 60_000);

  it('does not start a repair when the run ended after he answered', async () => {
    const { s, calls } = svc({ answeredAt: at(5), endedAt: at(4) });
    await s.onRunFailed('r1', { agentId: 'a1', error: 'Stopped at your request; nothing further was sent.', runKind: 'worker' });
    expect(calls).not.toContain('WOULD REPAIR');
  });

  // The wall is still worth having — a later rebuild should be able to see what it ran into.
  it('still keeps the evidence', async () => {
    const { s, calls } = svc({ answeredAt: at(5), endedAt: at(4) });
    await s.onRunFailed('r1', { agentId: 'a1', error: 'Stopped at your request.', runKind: 'worker' });
    expect(calls).toContain('kept');
  });

  // A real crash must still be repaired — this guard must not become a way for defects to hide.
  it('still repairs a run that failed on its own', async () => {
    const { s, calls } = svc({ answeredAt: null, endedAt: at(4) });
    await s.onRunFailed('r1', { agentId: 'a1', error: 'Could not fetch Reddit: fetch failed', runKind: 'worker' });
    expect(calls).toContain('WOULD REPAIR');
  });

  // A question answered mid-run, with the run carrying on and crashing LATER, is a real failure.
  it('repairs when the failure came before the answer, not after', async () => {
    const { s, calls } = svc({ answeredAt: at(2), endedAt: at(9) });
    await s.onRunFailed('r1', { agentId: 'a1', error: 'boom', runKind: 'worker' });
    expect(calls).toContain('WOULD REPAIR');
  });

  it('repairs when the run never asked him anything', async () => {
    const { s, calls } = svc({ answeredAt: null, endedAt: at(1) });
    await s.onRunFailed('r1', { agentId: 'a1', error: 'the contract was not met', runKind: 'worker' });
    expect(calls).toContain('WOULD REPAIR');
  });

  // It is the SHAPE of the ending that decides, never the words — a worker phrases its own stop.
  it('does not depend on how the worker worded it', async () => {
    const { s, calls } = svc({ answeredAt: at(3), endedAt: at(2) });
    await s.onRunFailed('r1', { agentId: 'a1', error: 'you asked me to halt, so I halted', runKind: 'worker' });
    expect(calls).not.toContain('WOULD REPAIR');
  });
});
