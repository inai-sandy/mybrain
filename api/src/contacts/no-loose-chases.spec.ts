import { RemindersService } from './reminders.service';
import { TaskHealthService } from '../tasks/task-health.service';

/**
 * BEA-1292 — a chase always points at a piece of work.
 *
 * The owner: *"Even when I mark the task as done, the reminders are not stopping."* On his live
 * data, 9 of 24 running chases had no task behind them at all, and the chase agent says why in one
 * line of its own code: `if (!item?.taskId) continue; // a chase with no task behind it has nothing
 * to claim`. Someone replied "done", it was recorded nowhere, the nudges carried on — and he had
 * nothing to tick either. Karthik was being chased three times over one daily production update.
 *
 * The fix is by CONSTRUCTION, not by a guard. A guard would have rejected the voice path (EMO sets
 * reminders with no task) and moved the failure somewhere else.
 */

function build(over: any = {}) {
  const created: any[] = [];
  const reminders: any[] = over.reminders || [];
  const prisma: any = {
    contact: { findUnique: async () => ({ id: 'c1', name: 'Shiva', whatsappNumber: '9199' }) },
    reminder: {
      create: async ({ data }: any) => { created.push(data); return { id: 'r-new', ...data }; },
      findUnique: async ({ where }: any) => reminders.find((r: any) => r.id === where.id) || null,
      findMany: async () => reminders,
      count: async ({ where }: any) => reminders.filter((r: any) => r.taskId === where.taskId && ['active', 'paused'].includes(r.status)).length,
      update: async ({ where, data }: any) => { const r = reminders.find((x: any) => x.id === where.id) || {}; Object.assign(r, data); return r; },
    },
    reminderSend: { deleteMany: async () => ({ count: 0 }), createMany: async () => ({ count: 0 }), findMany: async () => [] },
    task: {
      findUnique: async ({ where }: any) => (over.tasks || []).find((t: any) => t.id === where.id) || null,
      findMany: async () => over.tasks || [],
    },
    setting: { findUnique: async () => null },
  };
  const tasks: any = over.noTasksService
    ? undefined
    : {
        create: async (d: any) => {
          if (over.breakTaskCreate) throw new Error('database is down');
          const t = { id: `t-${created.length}`, ...d };
          (over.madeTasks || []).push(t);
          return t;
        },
      };
  const svc: any = new RemindersService(prisma, {} as any, {} as any, {} as any, tasks);
  svc.cleanSubject = async (s: string) => s || '';
  svc.reseed = async () => undefined;
  svc.get = async (id: string) => ({ id });
  svc.todayKey = () => '2026-08-13';
  return { svc, created, prisma, reminders };
}

describe('a new chase always has work behind it (BEA-1292)', () => {
  it('makes the task itself when the caller gives none — the voice path sets no task', async () => {
    const madeTasks: any[] = [];
    const { svc, created } = build({ madeTasks });
    await svc.create({ contactId: 'c1', subject: 'bill of materials status', message: 'Any update on the bill of materials?' });
    expect(created[0].taskId).toBe('t-0');
    expect(madeTasks[0]).toMatchObject({ ownerContactId: 'c1', kind: 'assignment' });
    expect(madeTasks[0].title).toContain('bill of materials status');
  });

  it('keeps the ORIGINAL words as the note — it is the only record of what was asked for', async () => {
    const madeTasks: any[] = [];
    const { svc } = build({ madeTasks });
    await svc.create({ contactId: 'c1', subject: 'the funds', message: 'Any tentative timeline on the funds?', notes: 'Kishore is the MD, be respectful' });
    expect(madeTasks[0].note).toBe('Kishore is the MD, be respectful');
  });

  it('a daily report becomes a RECURRING task, never a one-off', async () => {
    // The owner's correction: "For Karthik, the tasks are Daily Updates required, so they are not
    // actual tasks." Filing a standing report as an assignment would let it be confirmed done once
    // and never asked for again.
    const madeTasks: any[] = [];
    const { svc } = build({ madeTasks });
    await svc.create({ contactId: 'c1', subject: 'the production update', message: 'Share the production update', taskKind: 'recurring' });
    expect(madeTasks[0].kind).toBe('recurring');
    expect(madeTasks[0].title).toMatch(/^Send /);
  });

  it('FAILS the whole thing when the work cannot be created — never saves a chase nobody can finish', async () => {
    // Swallowing this would rebuild the exact bug the ticket closes, just less often and with
    // nothing in the log to say why. An error the owner can act on beats a reminder that is broken
    // from the moment it is made.
    const { svc, created } = build({ breakTaskCreate: true });
    await expect(svc.create({ contactId: 'c1', subject: 'the funds', message: 'Any update?' })).rejects.toThrow(/could not be created/i);
    expect(created).toHaveLength(0);
  });

  it('an explicitly-passed task is used as-is — no second task invented', async () => {
    const madeTasks: any[] = [];
    const { svc, created } = build({ madeTasks });
    await svc.create({ contactId: 'c1', taskId: 'given', subject: 'x', message: 'y' });
    expect(created[0].taskId).toBe('given');
    expect(madeTasks).toHaveLength(0);
  });
});

describe('fixing the chases that are already loose (BEA-1292)', () => {
  const loose = () => [{ id: 'r1', taskId: null, status: 'active', repeat: 'none', subject: 'the production update', message: 'Share it', notes: null, contactId: 'c1', contact: { id: 'c1', name: 'Karthik' } }];

  it('lists them with what that person already owes, so a duplicate can be merged', async () => {
    const { svc } = build({ reminders: loose(), tasks: [{ id: 'daily', title: 'Send daily Haasya production update by 7PM', kind: 'recurring' }] });
    const out = await svc.loose();
    expect(out.count).toBe(1);
    expect(out.items[0].contact.name).toBe('Karthik');
    expect(out.items[0].existingTasks[0].title).toContain('Haasya production update');
  });

  it('pointing it at work that is ALREADY chased stops this row instead of nudging twice', async () => {
    // Karthik had one real daily report and two loose chases about the same thing. Linking without
    // this check would have left three nudges pointing at one piece of work.
    const rows = [...loose(), { id: 'other', taskId: 'daily', status: 'active' }];
    const { svc } = build({ reminders: rows, tasks: [{ id: 'daily', title: 'Send daily production update', kind: 'recurring', ownerContactId: 'c1' }] });
    const res = await svc.linkLoose('r1', { mode: 'existing', taskId: 'daily' });
    expect(res).toMatchObject({ ok: true, merged: true, taskId: 'daily' });
    expect(rows[0].status).toBe('stopped');
    expect(rows[0].taskId).toBe('daily'); // still recorded, so the history is not lost
  });

  it('linking to work with no chase yet keeps the chase running', async () => {
    const rows = loose();
    const { svc } = build({ reminders: rows, tasks: [{ id: 'free', title: 'Add all videos', kind: 'assignment', ownerContactId: 'c1' }] });
    const res = await svc.linkLoose('r1', { mode: 'existing', taskId: 'free' });
    expect(res).toMatchObject({ ok: true, taskId: 'free' });
    expect(rows[0].status).toBe('active');
  });

  it('linking to a DAILY report switches the chase to repeat every day', async () => {
    const rows = loose();
    const { svc } = build({ reminders: rows, tasks: [{ id: 'daily', title: 'Send it', kind: 'recurring', ownerContactId: 'c1' }] });
    await svc.linkLoose('r1', { mode: 'existing', taskId: 'daily' });
    expect(rows[0].repeat).toBe('daily');
  });

  it('refuses to attach one person\'s chase to another person\'s work', async () => {
    const { svc } = build({ reminders: loose(), tasks: [{ id: 'theirs', title: 'Not yours', kind: 'assignment', ownerContactId: 'c-other' }] });
    await expect(svc.linkLoose('r1', { mode: 'existing', taskId: 'theirs' })).rejects.toThrow();
  });

  it('stopping one is a status change — the row is never deleted', async () => {
    const rows = loose();
    const { svc } = build({ reminders: rows });
    const res = await svc.linkLoose('r1', { mode: 'stop' });
    expect(res).toMatchObject({ ok: true, stopped: true });
    expect(rows[0].status).toBe('stopped');
    expect(rows).toHaveLength(1);
  });

  it('creating fresh work links it and reports what kind it made', async () => {
    const rows = loose();
    const madeTasks: any[] = [];
    const { svc } = build({ reminders: rows, madeTasks });
    const res = await svc.linkLoose('r1', { mode: 'daily', title: 'Send the daily production update' });
    expect(res).toMatchObject({ ok: true, created: true, kind: 'recurring' });
    expect(rows[0].repeat).toBe('daily');
    expect(madeTasks[0].title).toBe('Send the daily production update');
  });

  it('a row that already has work is left exactly as it is', async () => {
    const rows = [{ id: 'r1', taskId: 'already', status: 'active' }];
    const { svc } = build({ reminders: rows });
    expect(await svc.linkLoose('r1', { mode: 'stop' })).toMatchObject({ alreadyLinked: true });
    expect(rows[0].status).toBe('active');
  });

  it('an unknown mode is refused rather than guessed', async () => {
    const { svc } = build({ reminders: loose() });
    await expect(svc.linkLoose('r1', {})).rejects.toThrow();
  });
});

describe('the health check reports any that slip through (BEA-1292)', () => {
  it('names the people being chased about nothing', async () => {
    const prisma: any = {
      reminder: {
        findMany: async ({ where }: any) =>
          where?.taskId === null
            ? [{ subject: 'the production update', contact: { name: 'Karthik' } }, { subject: 'hiring', contact: { name: 'Swathi' } }]
            : [],
        groupBy: async () => [],
      },
      reminderSend: { findMany: async () => [] },
      task: { findMany: async () => [] },
      taskClaim: { findMany: async () => [] },
      taskStatusDay: { findMany: async () => [] },
      contact: { findMany: async () => [] },
      teamUpdate: { findMany: async () => [] },
    };
    const findings = await new TaskHealthService(prisma).check();
    const f = findings.find((x) => x.key === 'chase-without-task');
    expect(f).toBeTruthy();
    expect(f!.count).toBe(2);
    expect(f!.examples.join(' ')).toContain('Karthik');
  });

  it('stays SILENT when every chase has work behind it — silence has to mean healthy', async () => {
    const prisma: any = {
      reminder: { findMany: async () => [], groupBy: async () => [] },
      reminderSend: { findMany: async () => [] },
      task: { findMany: async () => [] },
      taskClaim: { findMany: async () => [] },
      taskStatusDay: { findMany: async () => [] },
      contact: { findMany: async () => [] },
      teamUpdate: { findMany: async () => [] },
    };
    const findings = await new TaskHealthService(prisma).check();
    expect(findings.find((x) => x.key === 'chase-without-task')).toBeUndefined();
  });
});
