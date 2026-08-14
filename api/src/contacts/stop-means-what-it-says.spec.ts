import { ReminderSenderService } from './reminder-sender.service';
import { RemindersService } from './reminders.service';

/**
 * BEA-1317 — a chase can be switched off for very different reasons, and they are not the same off.
 *
 * `settleDelegation` revives every chase sitting at `done` when work is re-opened, on the strength
 * of one claim: that `done` means "the app stopped this because the work ended", and nothing else.
 *
 * It did not. `stopChase` wrote `done` for three reasons — the work finished, a claim went past its
 * grace period, and **the person left the company**. So a chase for someone who had left was one
 * done → re-open cycle away from being switched back on and messaging them again.
 *
 * That is the bug BEA-1307 exists to prevent, and the rule was already written down in
 * `ContactsService.markLeft`: *"`stopped`, not `done`: the owner's own hand. `done` is what the app
 * writes when it decides, and those get offered back for resuming — which is not what 'they have
 * left' means."* One path simply did not follow it.
 *
 * These tests assert the STORED status per reason, because "we stopped it" is not the interesting
 * part — every version of this code stopped it. What matters is whether it can come back.
 */

function sender(over: any = {}) {
  const state: any = { updates: [] as any[], marks: [] as any[] };
  const send = over.send ?? {
    id: 's1',
    at: new Date(Date.now() - 60000),
    reminder: {
      id: 'r1',
      contactId: 'c1',
      taskId: 't1',
      times: '["10:00"]',
      status: 'active',
      contact: { id: 'c1', name: 'Radha', whatsappNumber: '+919812345678', leftAt: over.leftAt ?? null },
      task: over.task ?? { id: 't1', status: 'open', title: 'Place the PCBs' },
    },
  };
  const prisma: any = {
    reminderSend: {
      findMany: async ({ where }: any) => (where?.status === 'queued' && where?.at ? [send] : []),
      updateMany: async () => ({ count: 0 }),
      update: async ({ where, data }: any) => { state.marks.push({ id: where.id, ...data }); return {}; },
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
    },
    reminder: {
      findMany: async () => [],
      update: async ({ where, data }: any) => { state.updates.push({ id: where.id, ...data }); return {}; },
      updateMany: async () => ({ count: 0 }),
    },
    task: { findUnique: async () => over.task ?? { id: 't1', status: 'open', title: 'Place the PCBs' } },
    taskClaim: { findFirst: async () => over.claim ?? null },
    setting: { findUnique: async () => over.grace ?? null },
    contact: { findUnique: async () => ({ id: 'c1', name: 'Radha' }) },
  };
  const svc: any = new ReminderSenderService(prisma, { isConfigured: () => true, sendText: async () => ({ ok: true, id: 'w1' }) } as any, {} as any, {} as any);
  return { svc, state, prisma };
}

/** What the chase's status was set to, if it was set at all. */
const stoppedAs = (state: any) => state.updates.find((u: any) => u.status)?.status ?? null;

describe('someone who has left is stopped for good (BEA-1307/1317)', () => {
  it('their chase is `stopped`, which nothing revives on its own', async () => {
    const { svc, state } = sender({ leftAt: new Date('2026-08-01') });
    await svc.tickInner();
    expect(stoppedAs(state)).toBe('stopped');
  });

  it('and specifically NOT `done` — that is the state re-opening the work brings back', async () => {
    // The whole point. `done` would have let a done → re-open cycle start messaging Radha again,
    // months after she left, which is the single most embarrassing thing this system could do.
    const { svc, state } = sender({ leftAt: new Date('2026-08-01') });
    await svc.tickInner();
    expect(stoppedAs(state)).not.toBe('done');
  });

  it('and the queued message is skipped rather than sent', async () => {
    const { svc, state } = sender({ leftAt: new Date('2026-08-01') });
    await svc.tickInner();
    expect(state.marks[0]).toMatchObject({ status: 'skipped' });
  });
});

describe('work that genuinely finished is still revivable (BEA-1317)', () => {
  it('a chase stopped because the task is done is written `done`', async () => {
    // The one reason that SHOULD come back if he re-opens the work — he is saying it was not
    // finished after all. Without this the fix would have been "never revive anything".
    const { svc, state } = sender({ task: { id: 't1', status: 'done', title: 'Place the PCBs' } });
    await svc.tickInner();
    expect(stoppedAs(state)).toBe('done');
  });
});

describe('the generic PATCH cannot write the revivable state (BEA-1317)', () => {
  function svcFor() {
    // Every update, not just the last: setting a chase active also re-arms it, which is a SECOND
    // update whose data carries no status at all.
    const state: any = { calls: [] as any[] };
    const prisma: any = {
      reminder: {
        findUnique: async () => ({ id: 'r1', status: 'active', times: '["10:00"]', count: 1, armedDay: null }),
        update: async ({ data }: any) => { state.calls.push(data); return { id: 'r1' }; },
      },
      reminderSend: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    };
    return { svc: new RemindersService(prisma, {} as any, {} as any, {} as any), state };
  }

  it('`done` is ignored — it is not an outside caller\'s to set', async () => {
    const { svc, state } = svcFor();
    await (svc as any).update('r1', { status: 'done' });
    expect(state.calls.some((d: any) => d.status === 'done')).toBe(false);
  });

  it('but the owner\'s own paused and stopped still go through', async () => {
    for (const s of ['paused', 'stopped', 'active']) {
      const { svc, state } = svcFor();
      await (svc as any).update('r1', { status: s });
      expect({ s, wrote: state.calls.some((d: any) => d.status === s) }).toEqual({ s, wrote: true });
    }
  });
});

describe('"send today\'s chases" leaves finished work alone (BEA-1317)', () => {
  function resumeSvc(taskStatus: string) {
    const state: any = { activated: [] as string[] };
    const prisma: any = {
      reminder: {
        findMany: async () => [{ id: 'r1', taskId: 't1', times: '["10:00"]', status: 'paused' }],
        update: async ({ where, data }: any) => { if (data.status === 'active') state.activated.push(where.id); return {}; },
      },
      task: { findUnique: async () => ({ status: taskStatus }) },
      reminderSend: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }) },
    };
    return { svc: new RemindersService(prisma, {} as any, {} as any, {} as any), state };
  }

  it('a chase for work already finished is not woken', async () => {
    // It could not reach this sweep before: a chase he paused by hand was swept to `done` when the
    // work finished. Now his pause stays his pause, so it is visible here — and asking Deepthi
    // about something she finished last week is the exact message this system exists to prevent.
    const { svc, state } = resumeSvc('done');
    const r: any = await (svc as any).resumeToday();
    expect(state.activated).toEqual([]);
    expect(r).toMatchObject({ armed: 0, skipped: 1 });
  });

  it('and one for work still open is woken as before', async () => {
    const { svc, state } = resumeSvc('open');
    const r: any = await (svc as any).resumeToday();
    expect(state.activated).toEqual(['r1']);
    expect(r).toMatchObject({ armed: 1, skipped: 0 });
  });
});
