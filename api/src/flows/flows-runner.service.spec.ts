import { FlowRunnerService } from './flows-runner.service';

/**
 * BEA-776: a restart mid-run leaves FlowRun rows 'running' with no live driver, and start()'s
 * no-stacking guard then hands that dead run back forever. onModuleInit must fail those orphans —
 * but must NOT touch 'waiting' rows (they're durable and resume via answer()). cancelRun frees a
 * live run and must stick even if a lingering driver later tries to finish it.
 */
function runnerWithPrisma(prisma: any) {
  return new FlowRunnerService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
}

describe('FlowRunnerService.reconcileOrphans (BEA-776)', () => {
  it("fails orphaned 'running' runs on boot and leaves 'waiting' runs alone", async () => {
    const updates: any[] = [];
    const prisma = {
      flowRun: {
        findMany: async ({ where }: any) => {
          expect(where).toEqual({ status: 'running' }); // waiting is durable — never selected
          return [{ id: 'r1', terminal: '[]' }, { id: 'r2', terminal: null }];
        },
        update: async (args: any) => { updates.push(args); return {}; },
      },
    };
    const n = await runnerWithPrisma(prisma).reconcileOrphans();
    expect(n).toBe(2);
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.data.status).toBe('failed');
      expect(u.data.error).toMatch(/restart/i);
      expect(u.data.endedAt).toBeInstanceOf(Date);
    }
  });

  it('is a no-op when there are no orphans', async () => {
    const prisma = { flowRun: { findMany: async () => [], update: async () => { throw new Error('should not update'); } } };
    expect(await runnerWithPrisma(prisma).reconcileOrphans()).toBe(0);
  });
});

describe('FlowRunnerService.cancelRun (BEA-776)', () => {
  it("cancels a running run and frees the flow", async () => {
    let saved: any = null;
    const prisma = {
      flowRun: {
        findUnique: async () => ({ id: 'r1', status: 'running', terminal: '[]' }),
        update: async (args: any) => { saved = args; return {}; },
      },
    };
    const res = await runnerWithPrisma(prisma).cancelRun('r1');
    expect(res.ok).toBe(true);
    expect(saved.data.status).toBe('cancelled');
    expect(saved.data.endedAt).toBeInstanceOf(Date);
  });

  it("cancels a waiting run too", async () => {
    let saved: any = null;
    const prisma = {
      flowRun: {
        findUnique: async () => ({ id: 'r2', status: 'waiting', terminal: '[]' }),
        update: async (args: any) => { saved = args; return {}; },
      },
    };
    expect((await runnerWithPrisma(prisma).cancelRun('r2')).ok).toBe(true);
    expect(saved.data.status).toBe('cancelled');
  });

  it("does nothing for an already-finished run", async () => {
    const prisma = {
      flowRun: {
        findUnique: async () => ({ id: 'r3', status: 'done', terminal: '[]' }),
        update: async () => { throw new Error('should not update a finished run'); },
      },
    };
    expect((await runnerWithPrisma(prisma).cancelRun('r3')).ok).toBe(false);
  });
});
