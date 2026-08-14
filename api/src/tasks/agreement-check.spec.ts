import { TaskHealthService } from './task-health.service';

/**
 * BEA-1298 — does the app still agree with itself about delegated work?
 *
 * Background worth keeping: I predicted the app's several status columns had drifted apart and
 * proposed a rebuild. Run against the owner's live data on 2026-08-14, ten of these came back clean
 * and one had a single harmless leftover. The rebuild was dropped on that evidence and this was kept
 * instead — a fraction of the work, and it says every night whether that decision still holds.
 *
 * So the bar for each check is high: it must describe a state the app should not be able to REACH,
 * never one that is merely unusual. Silence has to keep meaning healthy, or the whole report becomes
 * noise and gets ignored — which is worse than not having it.
 */

/**
 * A stand-in that answers by the SHAPE of the query, the way the real one does. Routing on `where`
 * matters here: several checks read the same table for opposite things, and a stub that answered
 * every `reminder.findMany` with the same rows would make each of them look like it worked.
 */
function build(rows: Record<string, any[]> = {}) {
  const r = (k: string) => rows[k] || [];
  const prisma: any = {
    reminder: {
      findMany: async ({ where }: any) => {
        if (where?.needsOwner === true) return r('staleNeedsYou');
        if (where?.status === 'active' && where?.task?.claims) return r('chasingClaimed');
        if (where?.status === 'done' && where?.task) return r('silentlyOff');
        if (where?.status?.in && where?.taskId?.in) return r('liveSiblings'); // the "is it covered?" pass
        if (where?.pausedAuto) return r('autoOff');
        if (where?.task?.status === 'done') return r('chasingDone');
        if (where?.contact?.whatsappNumber === null) return r('noNumber');
        if (where?.taskId === null) return r('noTask');
        return [];
      },
      groupBy: async () => r('grouped'),
    },
    reminderSend: {
      findMany: async ({ where }: any) => {
        if (where?.reminder) return r('orphanQueued');
        if (where?.status === 'sending') return r('stuck');
        return r('overdue');
      },
    },
    task: {
      findMany: async ({ where }: any) => {
        if (where?.claims?.some?.status === 'confirmed') return r('confirmedButOpen');
        if (where?.kind === 'recurring' && where?.status === 'done') return r('recurringDone');
        if (where?.progress === 100) return r('openAt100');
        if (where?.kind === 'recurring') return r('recurring');
        return [];
      },
    },
    taskClaim: {
      findMany: async ({ where }: any) => (where?.task?.kind === 'recurring' ? r('recurringInReview') : r('oldClaims')),
    },
  };
  return new TaskHealthService(prisma);
}

const keys = async (svc: TaskHealthService) => (await svc.check()).map((f) => f.key);
const find = async (svc: TaskHealthService, key: string) => (await svc.check()).find((f) => f.key === key);

describe('a healthy app says nothing at all (BEA-1298)', () => {
  it('all eleven quiet — the state the owner is actually in today', async () => {
    const svc = build({});
    const findings = await svc.check();
    expect(findings).toEqual([]);
    expect(svc.message(findings)).toBe('');
  });
});

describe('each contradiction is caught, and named (BEA-1298)', () => {
  it('chasing someone about work they already reported finished', async () => {
    const svc = build({ chasingClaimed: [{ subject: 'the videos', contact: { name: 'Dharmendra' }, task: { title: 'Add all videos to the Beacon Hub' } }] });
    const f = await find(svc, 'chasing-claimed-work');
    expect(f?.count).toBe(1);
    expect(f?.examples[0]).toContain('Dharmendra');
    expect(f?.examples[0]).toContain('Add all videos'); // the WORK, not just the person
  });

  it('a chase that switched itself off while the work is still open', async () => {
    const svc = build({ silentlyOff: [{ taskId: 't1', subject: 'the bill of materials', contact: { name: 'Shiva' }, task: { title: 'Finish the bill of materials' } }] });
    expect(await keys(svc)).toContain('chase-silently-off');
  });

  it('but NOT when another chase on the same work is still running', async () => {
    // A merged duplicate is stopped on purpose and the work is still covered. Flagging it would
    // punish the tidy-up from BEA-1292 every single night.
    const svc = build({
      silentlyOff: [{ taskId: 't1', subject: 'x', contact: { name: 'Karthik' }, task: { title: 'Send daily production update' } }],
      liveSiblings: [{ taskId: 't1' }],
    });
    expect(await keys(svc)).not.toContain('chase-silently-off');
  });

  it('a claim you confirmed over a task that never closed', async () => {
    const svc = build({ confirmedButOpen: [{ title: 'Place the PCBs', ownerContact: { name: 'Deepthi' } }] });
    const f = await find(svc, 'confirmed-but-open');
    expect(f?.examples[0]).toContain('Deepthi');
  });

  it('a "needs you" flag left on work that is over — the one that fired on live data', async () => {
    const svc = build({ staleNeedsYou: [{ subject: 'Haasya recruitment', contact: { name: 'Swathi' }, task: { title: 'Get 10 people hired' } }] });
    expect(await keys(svc)).toContain('needs-you-on-finished-work');
  });

  it('a standing report closed for good', async () => {
    const svc = build({ recurringDone: [{ title: 'Send the daily production update', ownerContact: { name: 'Jayanth' } }] });
    const f = await find(svc, 'recurring-marked-done');
    expect(f?.what).toMatch(/never be asked for again/);
  });

  it('a standing report waiting on a yes/no it can never get', async () => {
    const svc = build({ recurringInReview: [{ task: { title: 'Send the OT update', ownerContact: { name: 'Jayanth' } } }] });
    const f = await find(svc, 'recurring-in-review');
    expect(f?.examples[0]).toContain('Jayanth');
  });

  it('messages still queued for a chase that is switched off', async () => {
    const svc = build({ orphanQueued: [{ reminder: { subject: 'the funds', contact: { name: 'Kishore' } } }] });
    expect(await keys(svc)).toContain('queued-for-stopped-chase');
  });
});

describe('the report stays readable (BEA-1298)', () => {
  it('says it changed nothing — a repair applied unattended at 3am beats the bug it aimed at', async () => {
    const svc = build({ recurringDone: [{ title: 'x', ownerContact: { name: 'Jayanth' } }] });
    const msg = svc.message(await svc.check());
    expect(msg).toMatch(/changed nothing/i);
  });

  it('one broken table cannot take the whole report down', async () => {
    // Each check is wrapped, so a schema change that breaks one query must not mean the owner
    // silently stops hearing about the other ten.
    const prisma: any = {
      reminder: { findMany: async () => { throw new Error('no such column'); }, groupBy: async () => [] },
      reminderSend: { findMany: async () => [] },
      task: { findMany: async ({ where }: any) => (where?.kind === 'recurring' && where?.status === 'done' ? [{ title: 'Send the OT update', ownerContact: { name: 'Jayanth' } }] : []) },
      taskClaim: { findMany: async () => [] },
    };
    const findings = await new TaskHealthService(prisma).check();
    expect(findings.map((f) => f.key)).toContain('recurring-marked-done');
  });

  it('a broken check is REPORTED, never mistaken for a healthy app', async () => {
    // The notifier does `check().catch(() => [])`. Without this, anything thrown here becomes an
    // empty list and the owner is told "all clear" on a night when nothing was checked — silence is
    // this feature's whole signal, so it has to be earned. (review finding)
    const prisma: any = {
      reminder: { findMany: async () => [], groupBy: async () => [] },
      reminderSend: { findMany: async () => [] },
      task: { findMany: async () => [] },
      taskClaim: { findMany: async () => [] },
    };
    const svc = new TaskHealthService(prisma);
    (svc as any).agreementChecks = async () => { throw new Error('no such column: needsOwner'); };
    const findings = await svc.check();
    const broken = findings.find((f) => f.key === 'health-check-broken');
    expect(broken).toBeTruthy();
    expect(broken!.examples[0]).toContain('no such column');
    expect(svc.message(findings)).not.toBe(''); // the owner actually hears about it
  });

  it('every finding tells you where to go and deal with it', async () => {
    const svc = build({
      chasingClaimed: [{ subject: 'a', contact: { name: 'A' }, task: { title: 'A' } }],
      confirmedButOpen: [{ title: 'B', ownerContact: { name: 'B' } }],
      recurringDone: [{ title: 'C', ownerContact: { name: 'C' } }],
    });
    for (const f of await svc.check()) expect(f.where).toMatch(/Tasks|Contacts/);
  });
});
