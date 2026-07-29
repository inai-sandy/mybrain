import { TaskHealthService } from './task-health.service';

/**
 * BEA-1190 — the app finds the broken states, not the owner. The rule that matters most is that
 * SILENCE MEANS HEALTHY: a check that cries wolf gets ignored, and then it is worse than nothing.
 */
function build(data: Partial<Record<string, any[]>> = {}, sent: string[] = []) {
  const prisma: any = {
    reminder: {
      findMany: async ({ where }: any) => {
        if (where?.task?.status === 'done') return data.chasingDone || [];
        if (where?.contact?.whatsappNumber === null) return data.noNumber || [];
        if (where?.pausedAuto) return data.autoOff || [];
        return [];
      },
      groupBy: async () => data.grouped || [],
    },
    reminderSend: { findMany: async ({ where }: any) => (where?.status === 'sending' ? data.stuck || [] : data.overdue || []) },
    task: {
      findMany: async ({ where }: any) => {
        if (where?.progress === 100) return data.openAt100 || [];
        if (where?.kind === 'recurring') return data.recurring || [];
        return [];
      },
    },
    taskClaim: { findMany: async () => data.oldClaims || [] },
  };
  void sent;
  return new TaskHealthService(prisma);
}

describe('the nightly tasks health check (BEA-1190)', () => {
  it('finds nothing when everything is fine, and has nothing to say', async () => {
    const svc = build({});
    const findings = await svc.check();
    expect(findings).toEqual([]);
    expect(svc.message(findings)).toBe(''); // silence means healthy
  });

  it('catches the one that messaged real people — chasing finished work', async () => {
    const svc = build({ chasingDone: [{ task: { title: 'Get production updates', party: 'Rakesh' } }] });
    const findings = await svc.check();
    expect(findings[0].key).toBe('chase-on-finished-work');
    const msg = svc.message(findings);
    expect(msg).toContain('already finished');
    expect(msg).toContain('Rakesh');          // concrete, not just a number
    expect(msg).toContain('changed nothing'); // it reports, it never fixes
  });

  it('catches a standing report that names a day but has no schedule', async () => {
    const svc = build({ recurring: [
      { title: 'Send Friday night production status update', scheduleDays: null },
      { title: 'Send the daily production update', scheduleDays: null },   // genuinely daily — fine
      { title: 'Share the Wednesday plan', scheduleDays: '["Wed"]' },      // already scheduled — fine
    ] });
    const f = (await svc.check()).find((x) => x.key === 'recurring-no-schedule');
    expect(f?.count).toBe(1);
    expect(f?.examples[0]).toContain('Friday');
  });

  it('catches double-chasing, stuck sends and overdue sends', async () => {
    const svc = build({
      grouped: [{ taskId: 't1', _count: { id: 2 } }],
      stuck: [{ id: 's1' }],
      overdue: [{ id: 's2' }, { id: 's3' }],
    });
    const keys = (await svc.check()).map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['double-chase', 'send-stuck', 'send-overdue']));
  });

  it('keeps going when one check cannot read its table', async () => {
    const prisma: any = {
      reminder: { findMany: async () => { throw new Error('db locked'); }, groupBy: async () => [] },
      reminderSend: { findMany: async () => [] },
      task: { findMany: async ({ where }: any) => (where?.progress === 100 ? [{ title: 'stuck at 100' }] : []) },
      taskClaim: { findMany: async () => [] },
    };
    const svc = new TaskHealthService(prisma);
    const f = await svc.check();
    expect(f.map((x) => x.key)).toContain('open-at-100'); // the healthy checks still reported
  });

  it('never reports a count of zero', async () => {
    const svc = build({ chasingDone: [], stuck: [], overdue: [] });
    expect(await svc.check()).toEqual([]);
  });
});

/**
 * The notifier lives in the telegram module because that module already depends on tasks. Wiring it
 * the other way round was a circular dependency: Nest refused to boot and the deploy rolled back.
 */
describe('who tells the owner (BEA-1190)', () => {
  const { TaskHealthNotifier } = require('../telegram/task-health-notifier.service');

  it('sends nothing at all when the checks are clean', async () => {
    const sent: string[] = [];
    const n = new TaskHealthNotifier({ check: async () => [], message: () => '' }, { ownerChatId: async () => 'o1', send: async (_c: any, t: string) => { sent.push(t); } });
    const r = await n.runAndReport();
    expect(r).toEqual({ found: 0, told: false });
    expect(sent).toEqual([]);
  });

  it('sends one message when something is wrong', async () => {
    const sent: string[] = [];
    const findings = [{ key: 'k', what: 'something broke', count: 2, examples: [], where: 'Tasks' }];
    const n = new TaskHealthNotifier({ check: async () => findings, message: () => 'the report' }, { ownerChatId: async () => 'o1', send: async (_c: any, t: string) => { sent.push(t); } });
    const r = await n.runAndReport();
    expect(r.told).toBe(true);
    expect(sent).toEqual(['the report']);
  });

  it('does not fall over when there is no one to tell', async () => {
    const findings = [{ key: 'k', what: 'x', count: 1, examples: [], where: 'Tasks' }];
    const n = new TaskHealthNotifier({ check: async () => findings, message: () => 'r' }, { ownerChatId: async () => null, send: async () => undefined });
    expect((await n.runAndReport()).told).toBe(false);
  });
});
