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

describe('closing a task stops its chase (BEA-1187)', () => {
  it('stops the chase when progress is dragged to 100', async () => {
    const { svc, reminderUpdates, sendDeletes } = build(delegated);
    await svc.update('t1', { progress: 100 });
    expect(reminderUpdates.length).toBe(1);
    expect(reminderUpdates[0].where).toMatchObject({ taskId: 't1' });
    expect(reminderUpdates[0].data).toMatchObject({ status: 'done' });
    expect(sendDeletes.length).toBe(1); // queued sends cleared too
  });

  it('resumes a repeating chase when the task is re-opened', async () => {
    const { svc, reminderUpdates } = build({ ...delegated, status: 'done', progress: 100 });
    await svc.update('t1', { progress: 50 });
    expect(reminderUpdates.length).toBe(1);
    expect(reminderUpdates[0].data).toMatchObject({ status: 'active' });
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
