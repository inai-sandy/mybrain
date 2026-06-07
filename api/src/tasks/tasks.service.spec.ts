import { TasksService } from './tasks.service';

function makeService(llmText: string | null) {
  const settings: Record<string, string> = {};
  const tasks: any[] = [];
  const dumps: any[] = [];
  let seq = 0;
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = (update?.value ?? create.value);
        return { key: where.key, value: settings[where.key] };
      },
    },
    brainDump: {
      create: async ({ data }: any) => {
        const row = { id: `d${++seq}`, createdAt: new Date(), ...data };
        dumps.push(row);
        return row;
      },
      findFirst: async ({ where }: any) => dumps.filter((d) => d.day === where.day).slice(-1)[0] || null,
    },
    task: {
      create: async ({ data }: any) => {
        const row = { id: `t${++seq}`, createdAt: new Date(), status: 'open', rolloverCount: 0, pinned: false, priority: 'medium', ...data };
        tasks.push(row);
        return row;
      },
      findMany: async ({ where }: any = {}) =>
        tasks.filter((t) => {
          if (where?.status && t.status !== where.status) return false;
          const d = where?.day;
          if (d !== undefined) {
            if (typeof d === 'string') {
              if (t.day !== d) return false;
            } else {
              if (d.not === null && (t.day === null || t.day === undefined)) return false;
              if (d.lt && !(t.day && t.day < d.lt)) return false;
            }
          }
          return true;
        }),
      findUnique: async ({ where }: any) => tasks.find((t) => t.id === where.id) || null,
      update: async ({ where, data }: any) => {
        const t = tasks.find((x) => x.id === where.id);
        Object.assign(t, data);
        return t;
      },
      delete: async ({ where }: any) => {
        const i = tasks.findIndex((x) => x.id === where.id);
        if (i >= 0) tasks.splice(i, 1);
        return {};
      },
    },
  };
  const llm: any = { completeWith: async () => llmText, listOpenRouterModels: async () => [] };
  return { svc: new TasksService(prisma, llm), tasks };
}

describe('TasksService', () => {
  it('defaults the engine model to Claude Sonnet', async () => {
    const { svc } = makeService(null);
    const m = await svc.getModel();
    expect(m.provider).toBe('openrouter');
    expect(m.model).toContain('sonnet');
  });

  it('turns a dump into tasks, normalizes priority, and caps pins at 3', async () => {
    const json = JSON.stringify({
      question: null,
      tasks: [
        { title: 'Finish proposal', priority: 'high', estimateMin: 90, pinned: true, category: 'Beakn', tags: ['WRITE'] },
        { title: 'Call accountant', priority: 'urgent', pinned: true },
        { title: 'Gym', priority: 'low', pinned: true },
        { title: 'Read RAG paper', priority: 'medium', pinned: true },
      ],
    });
    const { svc } = makeService(json);
    const res = await svc.dump('proposal, accountant, gym, rag paper');
    expect(res.tasks).toHaveLength(4);
    // 'urgent' is not a valid priority -> normalized to medium
    expect(res.tasks.find((t) => t.title === 'Call accountant')!.priority).toBe('medium');
    // tags lowercased
    expect(res.tasks[0].tags).toEqual(['write']);
    // at most 3 pinned even though 4 were marked
    expect(res.tasks.filter((t) => t.pinned)).toHaveLength(3);
  });

  it('records a clarifying question and makes no tasks when the dump is too vague', async () => {
    const { svc, tasks } = makeService(JSON.stringify({ question: 'What do you mean by "stuff"?', tasks: [] }));
    const res = await svc.dump('stuff');
    expect(res.question).toContain('stuff');
    expect(res.tasks).toHaveLength(0);
    expect(tasks).toHaveLength(0);
  });

  it('marks a task done and records the actual time', async () => {
    const { svc } = makeService(JSON.stringify({ tasks: [{ title: 'X', estimateMin: 30 }] }));
    const { tasks } = await svc.dump('x');
    const id = tasks[0].id;
    const done = await svc.setDone(id, true, 45);
    expect(done!.status).toBe('done');
    expect(done!.actualMin).toBe(45);
    expect(done!.completedAt).toBeTruthy();
  });

  it('falls back to a single task if the LLM is unavailable so nothing is lost', async () => {
    const { svc } = makeService(null);
    const res = await svc.dump('one big messy thought');
    expect(res.tasks).toHaveLength(1);
    expect(res.tasks[0].title).toContain('one big messy thought');
  });

  it('schedules N smart reminder times when a task asks for reminders', async () => {
    const { svc } = makeService(null);
    const t = await svc.create({ title: 'Pay rent', priority: 'high', reminderCount: 2 });
    expect(t!.reminderCount).toBe(2);
    expect(t!.reminders).toHaveLength(2);
    expect(t!.reminders[0]).toMatch(/^\d{2}:\d{2}$/);
  });

  it('does not roll tasks on first boot, but carries open tasks forward on a day change', async () => {
    const { svc, tasks } = makeService(JSON.stringify({ tasks: [{ title: 'Yesterday job' }] }));
    const { tasks: made } = await svc.dump('job');
    const id = made[0].id;

    // First boot: no lastRollDay yet -> it just records today, rolls nothing.
    const first = await svc.rolloverTick();
    expect(first!.rolled).toBe(0);

    // Simulate the task being left open from a previous day, and a stale roll marker.
    const row = tasks.find((x) => x.id === id);
    row.day = '2000-01-01';
    row.status = 'open';
    await (svc as any).prisma.setting.upsert({ where: { key: 'tasks.lastRollDay' }, create: { key: 'tasks.lastRollDay', value: '2000-01-01' }, update: { value: '2000-01-01' } });

    const second = await svc.rolloverTick();
    expect(second!.rolled).toBe(1);
    expect(row.day).not.toBe('2000-01-01');
    expect(row.rolloverCount).toBe(1);
  });
});
