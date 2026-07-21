import { TasksService, normTitleKey } from './tasks.service';

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

  it('rollDayForward counts the carry but NEVER moves the date (BEA-1014)', async () => {
    const { svc, tasks } = makeService(JSON.stringify({ tasks: [{ title: 'Carry me' }, { title: 'Already done' }] }));
    const { tasks: made } = await svc.dump('two');
    const open = tasks.find((x) => x.id === made[0].id);
    const done = tasks.find((x) => x.id === made[1].id);
    open.day = '2026-06-12';
    open.status = 'open';
    done.day = '2026-06-12';
    done.status = 'done';

    const r = await svc.rollDayForward('2026-06-12', '2026-06-13');
    expect(r.rolled).toBe(1); // only the open task is carried
    // The task KEEPS the day it was added — re-stamping it made every open task claim it was
    // created today, and destroyed the record of what each day produced. Today picks it up by
    // querying `day <= today` instead. (BEA-1014)
    expect(open.day).toBe('2026-06-12');
    expect(open.rolloverCount).toBe(1); // but we do count how long it has been carried
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

describe('normTitleKey — dedupe key for dump tasks (BEA-933)', () => {
  it('ignores case, punctuation, and extra whitespace', () => {
    expect(normTitleKey('Fix the screen problem')).toBe(normTitleKey('fix the  screen problem!'));
    expect(normTitleKey('Get production updates from Madhuri.')).toBe('get production updates from madhuri');
  });
  it('keeps genuinely different titles distinct', () => {
    expect(normTitleKey('Get updates from Madhuri')).not.toBe(normTitleKey('Get updates from Karthik'));
  });
  it('handles null/empty', () => {
    expect(normTitleKey(null)).toBe('');
    expect(normTitleKey('   ')).toBe('');
  });
});

describe('create() note guarantee (BEA-955)', () => {
  it('auto tasks always get a note (AI backstop); caller context wins; manual stays optional', async () => {
    const { svc, tasks } = makeService('Screen issue reported; needs a fix');
    await (svc as any).create({ title: 'Fix screen', category: 'Tech', auto: true });
    expect(tasks[tasks.length - 1].note).toBe('Screen issue reported; needs a fix'); // AI backstop filled it

    await (svc as any).create({ title: 'Ship it', auto: true, note: 'Deploy after tests pass' });
    expect(tasks[tasks.length - 1].note).toBe('Deploy after tests pass'); // real context wins over AI

    await (svc as any).create({ title: 'Buy milk' }); // manual (no auto), no note
    expect(tasks[tasks.length - 1].note).toBeNull(); // stays optional
  });

  it('honours an explicit day (for suggestion-approve on its forDay)', async () => {
    const { svc, tasks } = makeService(null);
    await (svc as any).create({ title: 'Prep deck', auto: true, note: 'for the review', day: '2026-08-01' });
    expect(tasks[tasks.length - 1].day).toBe('2026-08-01');
  });
});

describe('indexTask — the dates EMO reads (BEA-1013)', () => {
  /** Capture exactly what gets sent to the brain for one task. */
  function indexed(task: any): { content: string } {
    const sent: any[] = [];
    const memory: any = { indexEntity: async (a: any) => { sent.push(a); }, deleteDoc: async () => undefined, enqueue: async () => undefined };
    const prisma: any = { task: { update: async () => task } };
    const svc: any = new TasksService(prisma, {} as any, {} as any, memory);
    svc.indexTask(task);
    return sent[0] || { content: '' };
  }

  it('a finished task carries when it was ADDED and when it was COMPLETED — never the rolled-over day', () => {
    const { content } = indexed({
      id: 't1', title: 'Buy jewelry for Arya', status: 'done', tags: '[]',
      createdAt: new Date('2026-07-12T00:41:00Z'), completedAt: new Date('2026-07-12T09:00:00Z'),
      day: '2026-07-21', // the misleading rolled day
    });
    expect(content).toContain('Added: 2026-07-12');
    expect(content).toContain('Completed: 2026-07-12');
    expect(content).not.toContain('2026-07-21'); // the rolled day must NOT be the date it states
  });

  it('an OPEN task is not indexed here at all — done-only (BEA-546); its text comes from MemoryService', () => {
    const { content } = indexed({
      id: 't2', title: "Plan and purchase items for Arya's birthday", status: 'open', tags: '[]',
      createdAt: new Date('2026-07-12T20:40:00Z'), completedAt: null, rolloverCount: 9, day: '2026-07-21',
    });
    expect(content).toBe(''); // nothing sent to the brain for an open task
  });
});

describe('today() — carried tasks stay visible without faking their date (BEA-1014)', () => {
  const IST = 'Asia/Kolkata';
  const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  function svcWith(rows: any[]) {
    const prisma: any = {
      setting: { findUnique: async () => ({ value: IST }) },
      brainDump: { findFirst: async () => null },
      task: {
        findMany: async ({ where }: any) => rows.filter((t) => {
          const or = where?.OR || [];
          return or.some((c: any) => {
            if (c.status && c.status !== t.status) return false;
            if (c.day && typeof c.day === 'string' && c.day !== t.day) return false;
            if (c.day?.lte && !(t.day <= c.day.lte)) return false;
            if (c.completedAt?.gte && !(t.completedAt && new Date(t.completedAt) >= c.completedAt.gte)) return false;
            return true;
          });
        }),
      },
    };
    return new TasksService(prisma, {} as any, {} as any, { indexEntity: async () => undefined, deleteDoc: async () => undefined } as any);
  }

  it('shows an OLD still-open task on Today, still dated the day it was added', async () => {
    const today = istToday();
    const svc = svcWith([{ id: 'old', title: 'Installation charges', status: 'open', day: '2026-06-09', rolloverCount: 42, tags: null }]);
    const out: any = await svc.today();
    expect(out.tasks.map((t: any) => t.id)).toContain('old'); // visible today...
    expect(out.tasks[0].day).toBe('2026-06-09');              // ...but honest about its real date
    expect(out.tasks[0].rolloverCount).toBe(42);              // so the UI can say "carried 42 days"
    expect(out.day).toBe(today);
  });

  it('counts a carried task FINISHED today in today\'s record', async () => {
    const svc = svcWith([{ id: 'fin', title: 'Old thing', status: 'done', day: '2026-06-09', completedAt: new Date(), tags: null }]);
    const out: any = await svc.today();
    expect(out.tasks.map((t: any) => t.id)).toContain('fin'); // finishing it today must not vanish
    expect(out.counts.done).toBe(1);
  });

  it('does NOT show a task that was finished on an earlier day', async () => {
    const svc = svcWith([{ id: 'oldDone', title: 'Long done', status: 'done', day: '2026-06-09', completedAt: new Date('2026-06-09T10:00:00Z'), tags: null }]);
    const out: any = await svc.today();
    expect(out.tasks.map((t: any) => t.id)).not.toContain('oldDone');
  });
});
