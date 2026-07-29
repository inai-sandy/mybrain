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
  const telegram: any = { ownerChatId: async () => 'owner-1', send: async (_c: string, text: string) => { sent.push(text); } };
  return new TaskHealthService(prisma, telegram);
}

describe('the nightly tasks health check (BEA-1190)', () => {
  it('says NOTHING when everything is fine', async () => {
    const sent: string[] = [];
    const r = await build({}, sent).runAndReport();
    expect(r.findings).toEqual([]);
    expect(r.told).toBe(false);
    expect(sent).toEqual([]); // silence means healthy
  });

  it('catches the one that messaged real people — chasing finished work', async () => {
    const sent: string[] = [];
    const svc = build({ chasingDone: [{ task: { title: 'Get production updates', party: 'Rakesh' } }] }, sent);
    const r = await svc.runAndReport();
    expect(r.findings[0].key).toBe('chase-on-finished-work');
    expect(r.told).toBe(true);
    expect(sent[0]).toContain('already finished');
    expect(sent[0]).toContain('Rakesh');       // concrete, not just a number
    expect(sent[0]).toContain('changed nothing'); // it reports, it never fixes
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
    const svc = new TaskHealthService(prisma, undefined);
    const f = await svc.check();
    expect(f.map((x) => x.key)).toContain('open-at-100'); // the healthy checks still reported
  });

  it('never reports a count of zero', async () => {
    const svc = build({ chasingDone: [], stuck: [], overdue: [] });
    expect(await svc.check()).toEqual([]);
  });
});
