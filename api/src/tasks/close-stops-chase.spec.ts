import { TasksService } from './tasks.service';

/**
 * BEA-1187 — a chase exists to get one piece of work finished, so finishing the work must stop it
 * WHEREVER the task was closed. Closing by dragging progress to 100 used to leave the reminders
 * running, and the person kept being chased about work that was already done.
 */
function build(task: any) {
  const reminderUpdates: any[] = [];
  const sendDeletes: any[] = [];
  const prisma: any = {
    task: {
      findUnique: async () => task,
      update: async ({ data }: any) => ({ ...task, ...data }),
    },
    reminder: { updateMany: async (args: any) => { reminderUpdates.push(args); return { count: 1 }; } },
    reminderSend: { deleteMany: async (args: any) => { sendDeletes.push(args); return { count: 1 }; } },
    contact: { findMany: async () => [] },
    taskPerson: { findMany: async () => [], deleteMany: async () => ({}), createMany: async () => ({}) },
  };
  const svc: any = new TasksService(prisma, {} as any, {} as any, {} as any);
  // keep the test on the one behaviour under examination
  svc.indexTask = () => undefined;
  svc.touchPerson = () => undefined;
  svc.allContacts = async () => [];
  svc.syncPeople = async () => undefined;
  svc.shape = (x: any) => x;
  return { svc, reminderUpdates, sendDeletes };
}

const delegated = { id: 't1', title: 'Send the report', status: 'open', progress: 50, ownerContactId: 'c1', party: 'Madhuri', priority: 'medium', reminderCount: 0, reminders: null, kind: 'assignment' };

/**
 * Assert on WHAT happened rather than on how many queries it took. A bare call count broke the
 * moment the shared rule also cleared the "needs you" badge (BEA-1296) — and a count is the weaker
 * check anyway: it passes just as happily when the one update that matters is the wrong one.
 */
const didUpdate = (calls: any[], data: any) => calls.filter((c) => Object.entries(data).every(([k, v]) => c.data?.[k] === v));

describe('closing a task stops its chase (BEA-1187)', () => {
  it('stops the chase when progress is dragged to 100', async () => {
    const { svc, reminderUpdates, sendDeletes } = build(delegated);
    await svc.update('t1', { progress: 100 });
    // Two updates, not one: what was RUNNING, and what the app had paused itself because somebody
    // claimed the work was done. A chase the owner paused by hand is deliberately not in either —
    // it is already silent, and leaving it alone is what lets re-opening tell them apart. (BEA-1317)
    const stop = didUpdate(reminderUpdates, { status: 'done' });
    expect(stop.every((c) => c.where?.taskId === 't1')).toBe(true);
    expect(stop.map((c) => c.where?.status).sort()).toEqual(['active', 'paused']);
    expect(stop.find((c) => c.where?.status === 'paused')?.where).toMatchObject({ pausedAuto: true });
    expect(sendDeletes.length).toBe(1); // queued sends cleared too
  });

  it('clears the "needs you" badge on the same task (BEA-1296)', async () => {
    // A flag raised because the agent got stuck on this task outlived the task itself — nothing
    // ever cleared it when the work finished.
    const { svc, reminderUpdates } = build(delegated);
    await svc.update('t1', { progress: 100 });
    const cleared = didUpdate(reminderUpdates, { needsOwner: false });
    expect(cleared).toHaveLength(1);
    expect(cleared[0].where).toMatchObject({ taskId: 't1', needsOwner: true });
  });

  it('resumes a repeating chase when the task is re-opened', async () => {
    const { svc, reminderUpdates } = build({ ...delegated, status: 'done', progress: 100 });
    await svc.update('t1', { progress: 50 });
    const woken = didUpdate(reminderUpdates, { status: 'active' });
    expect(woken.length).toBeGreaterThan(0);
    // No longer limited to `repeat: 'daily'`. A one-off chase used to stay stopped for ever, so the
    // job came back open with nobody being asked about it. (BEA-1317)
    const fromDone = woken.find((c) => c.where?.status === 'done');
    expect(fromDone).toBeTruthy();
    expect(fromDone!.where.repeat).toBeUndefined();
  });

  it('re-opening also wakes a chase that was paused by a claim (BEA-1293)', async () => {
    // Re-opening IS the owner saying the claim was wrong. Without this, "pause on done" would
    // quietly behave like "stop on done" — the exact bug it exists to fix.
    const { svc, reminderUpdates } = build({ ...delegated, status: 'done', progress: 100 });
    await svc.update('t1', { progress: 50 });
    const fromPause = reminderUpdates.filter((c) => c.where?.status === 'paused');
    expect(fromPause).toHaveLength(1);
    expect(fromPause[0].where).toMatchObject({ pausedAuto: true }); // never one HE paused by hand
    expect(fromPause[0].data).toMatchObject({ status: 'active' });
  });

  it('leaves chases alone when the status did not change', async () => {
    const { svc, reminderUpdates, sendDeletes } = build(delegated);
    await svc.update('t1', { title: 'Send the report today' });
    expect(reminderUpdates.length).toBe(0);
    expect(sendDeletes.length).toBe(0);
  });

  it('leaves chases alone when progress moves but does not reach 100', async () => {
    const { svc, reminderUpdates } = build(delegated);
    await svc.update('t1', { progress: 75 });
    expect(reminderUpdates.length).toBe(0);
  });
});
