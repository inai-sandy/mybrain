import { TasksService } from './tasks.service';

function makeService(llmText: string | null) {
  const settings: Record<string, string> = {};
  const tasks: any[] = [];
  const dumps: any[] = [];
  let seq = 0;
  const prisma: any = {
    contact: { findMany: async () => [] },
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
  const prompts: any = { get: async () => 'Turn this brain-dump into tasks as JSON.' };
  // Indexing is fire-and-forget; a no-op memory keeps the unit tests focused on task logic.
  const memory: any = { indexEntity: async () => undefined, deleteDoc: async () => undefined, enqueue: async () => undefined };
  return { svc: new TasksService(prisma, llm, prompts, memory), tasks };
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

  it('un-checking a done task resets its progress to 0, not 100 (BEA-807)', async () => {
    const { svc } = makeService(JSON.stringify({ tasks: [{ title: 'X' }] }));
    const { tasks } = await svc.dump('x');
    const id = tasks[0].id;
    await svc.setDone(id, true);                 // progress -> 100
    const reopened = await svc.setDone(id, false); // un-check
    expect(reopened!.status).toBe('open');
    expect(reopened!.progress).toBe(0);          // NOT left at 100 (which inflated every weighted metric)
  });

  it('saves partial progress (30/60) and snaps stray values to the nearest step', async () => {
    const { svc } = makeService(JSON.stringify({ tasks: [{ title: 'Big job' }] }));
    const { tasks } = await svc.dump('big job');
    const id = tasks[0].id;
    const at60 = await svc.update(id, { progress: 60 });
    expect(at60!.progress).toBe(60);
    expect(at60!.status).toBe('open');
    // a stray value snaps to the closest allowed step
    const snapped = await svc.update(id, { progress: 42 });
    expect(snapped!.progress).toBe(30);
  });

  it('treats 100% progress as done', async () => {
    const { svc } = makeService(JSON.stringify({ tasks: [{ title: 'Finish' }] }));
    const { tasks } = await svc.dump('finish');
    const done = await svc.update(tasks[0].id, { progress: 100 });
    expect(done!.progress).toBe(100);
    expect(done!.status).toBe('done');
    expect(done!.completedAt).toBeTruthy();
  });

  it('spawns a "Follow up:" task on the chosen day when completing with a follow-up date', async () => {
    const { svc, tasks } = makeService(JSON.stringify({ tasks: [{ title: 'Email client', category: 'Beakn' }] }));
    const { tasks: made } = await svc.dump('email client');
    expect(tasks).toHaveLength(1);
    await svc.setDone(made[0].id, true, undefined, '2026-06-10');
    const follow = tasks.find((t) => t.followUp);
    expect(follow).toBeTruthy();
    expect(follow!.title).toBe('Follow up: Email client');
    expect(follow!.day).toBe('2026-06-10');
    expect(follow!.category).toBe('Beakn');
  });

  it('does not spawn a follow-up when no date is given or the date is malformed', async () => {
    const { svc, tasks } = makeService(JSON.stringify({ tasks: [{ title: 'Just finish' }] }));
    const { tasks: made } = await svc.dump('just finish');
    await svc.setDone(made[0].id, true, undefined, 'next week');
    expect(tasks.filter((t) => t.followUp)).toHaveLength(0);
  });

  it('forDay returns only that day\'s tasks, done and open', async () => {
    const { svc, tasks } = makeService(null);
    tasks.push({ id: 'a', day: '2026-06-01', status: 'done', title: 'Old win', priority: 'medium', pinned: false, rolloverCount: 0, createdAt: new Date() });
    tasks.push({ id: 'b', day: '2026-06-01', status: 'open', title: 'Old open', priority: 'medium', pinned: false, rolloverCount: 0, createdAt: new Date() });
    tasks.push({ id: 'c', day: '2026-06-02', status: 'done', title: 'Other day', priority: 'medium', pinned: false, rolloverCount: 0, createdAt: new Date() });
    const list = await svc.forDay('2026-06-01');
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.id).sort()).toEqual(['a', 'b']);
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

  it('byPerson finds tasks naming the person (and merge/rename aliases), with word-boundary matching', async () => {
    const { svc, tasks } = makeService(JSON.stringify({ tasks: [{ title: 'seed' }] }));
    await svc.dump('seed');
    tasks.length = 0; // start clean
    tasks.push(
      { id: '1', title: 'Discuss payments with Srikar', note: null, status: 'open', day: '2026-06-10', tags: null },
      { id: '2', title: 'Call Allison about the plan', note: null, status: 'done', day: '2026-06-11', tags: null },
      { id: '3', title: 'Buy bananas', note: null, status: 'open', day: '2026-06-12', tags: null }, // must NOT match "Ana"
      { id: '4', title: 'Send report', note: 'follow up with Srikar after', status: 'open', day: '2026-06-12', tags: null },
    );
    await (svc as any).prisma.setting.upsert({ where: { key: 'people.aliases' }, create: { key: 'people.aliases', value: JSON.stringify({ Allison: 'Alisan' }) }, update: { value: JSON.stringify({ Allison: 'Alisan' }) } });

    const srikar = await svc.byPerson('Srikar');
    expect(srikar.map((t: any) => t.id).sort()).toEqual(['1', '4']); // title + note, not the banana

    const alisan = await svc.byPerson('Alisan'); // alias Allison -> Alisan
    expect(alisan.map((t: any) => t.id)).toEqual(['2']);
  });

  it('rollDayForward carries a closed day\'s open tasks forward; finished tasks stay on their day', async () => {
    const { svc, tasks } = makeService(JSON.stringify({ tasks: [{ title: 'Carry me' }, { title: 'Already done' }] }));
    const { tasks: made } = await svc.dump('two');
    const open = tasks.find((x) => x.id === made[0].id);
    const done = tasks.find((x) => x.id === made[1].id);
    open.day = '2026-06-12';
    open.status = 'open';
    done.day = '2026-06-12';
    done.status = 'done';

    const r = await svc.rollDayForward('2026-06-12', '2026-06-13');
    expect(r.rolled).toBe(1); // only the open task moves
    expect(open.day).toBe('2026-06-13');
    expect(open.rolloverCount).toBe(1);
    expect(done.day).toBe('2026-06-12'); // a finished task stays credited to its real day

    // never rolls same-day or backwards
    expect((await svc.rollDayForward('2026-06-13', '2026-06-13')).rolled).toBe(0);
  });

  it('clears category / estimate / note when the edit sends null (BEA-782)', async () => {
    const { svc, tasks } = makeService(null);
    const created = await svc.create({ title: 'Wire the panel', category: 'Beakn', estimateMin: 45, note: 'ask Srikar first' });
    expect(created).toMatchObject({ category: 'Beakn', estimateMin: 45, note: 'ask Srikar first' });

    // the form now sends null (not undefined) for a cleared field
    await svc.update(created!.id, { category: null as any, estimateMin: null as any, note: null as any });
    const after = tasks.find((t) => t.id === created!.id);
    expect(after.category).toBeNull();
    expect(after.estimateMin).toBeNull();
    expect(after.note).toBeNull();

    // an ABSENT field (undefined) must still keep the old value
    await svc.update(created!.id, { title: 'Wire the panel v2' });
    expect(after.title).toBe('Wire the panel v2');
    expect(after.category).toBeNull(); // untouched
  });
});
