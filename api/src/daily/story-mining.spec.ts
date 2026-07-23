import { StoryMiningService } from './story-mining.service';

/**
 * The promises of deep story mining (BEA-1051):
 *  - one read proposes every section, nothing is created until applied,
 *  - a person is NEVER guessed — exact contact match or unlinked,
 *  - already-logged work is not re-proposed,
 *  - applying goes through the real doors (tasks, chases, promises, Lab).
 */
const RICH = JSON.stringify({
  done: [{ title: 'Fixed the QC checklist', category: 'Factory' }],
  todos: [{ title: 'Order solder paste', category: 'Factory', note: 'before Monday', priority: 'high' }],
  delegations: [
    { person: 'Madhuri', title: 'Send the Focus ERP report', chase: true },
    { person: 'Someone New', title: 'Paint the stall banners', chase: true },
  ],
  myReminders: [{ title: 'Renew the insurance', date: '2026-07-30' }],
  promises: [{ to: 'Srikar', what: 'Pay the pending invoice', date: '2026-07-25' }],
  emotions: { lifted: ['EMO demo went well'], drained: ['late-night rework'], energy: 70, worry: 40, feeling: 'Tired but proud.' },
  events: [{ at: 'morning', title: 'At the factory checking QC' }, { at: 'evening', title: 'EMO testing at home' }],
  lessons: ['Late-night rework always eats the next morning'],
});

function make(llmReply: string | null, opts: { existingTitles?: string[] } = {}) {
  const createdTasks: any[] = [];
  const doneTasks: any[] = [];
  const chases: any[] = [];
  const dayEvents: any[] = [];
  const findings: any[] = [];
  const storyUpdates: any[] = [];
  let seq = 0;
  const prisma: any = {
    story: {
      findFirst: async () => ({ id: 'st1', day: '2026-07-22', rawText: 'A long real diary entry about the whole day at the factory and beyond.' }),
      update: async ({ data }: any) => { storyUpdates.push(data); return {}; },
    },
    task: {
      findMany: async ({ where }: any) => (where?.status ? [] : (opts.existingTitles || []).map((t) => ({ title: t }))),
      update: async ({ where, data }: any) => { const t = createdTasks.find((x) => x.id === where.id); if (t) Object.assign(t, data); return t; },
    },
    contact: { findMany: async () => [{ id: 'c-mad', name: 'Madhuri', aliases: '[]' }, { id: 'c-sri', name: 'Srikar', aliases: '[]' }] },
    dayEvent: {
      deleteMany: async () => ({}),
      create: async ({ data }: any) => { dayEvents.push(data); return data; },
    },
    mindFinding: { create: async ({ data }: any) => { findings.push(data); return { id: 'f1', ...data }; } },
  };
  const llm: any = { completeWith: async () => llmReply };
  const tasks: any = {
    whereForDay: async () => ({}),
    create: async (d: any) => { const t = { id: `t${++seq}`, ...d }; createdTasks.push(t); return t; },
    createDoneTask: async (title: string, category: any, day: string) => { const t = { id: `d${++seq}`, title, category, day }; doneTasks.push(t); return t; },
  };
  const reminders: any = { create: async (d: any) => { chases.push(d); return d; } };
  const daily: any = { storyModel: async () => ({ provider: 'openrouter', model: 'x' }) };
  const svc = new StoryMiningService(prisma, llm, tasks, reminders, daily);
  return { svc, createdTasks, doneTasks, chases, dayEvents, findings, storyUpdates };
}

describe('mine — proposes everything, creates nothing (BEA-1051)', () => {
  it('returns every section from a rich diary', async () => {
    const { svc, createdTasks, doneTasks } = make(RICH);
    const m = await svc.mine('2026-07-22');
    expect(m.done.map((d) => d.title)).toEqual(['Fixed the QC checklist']);
    expect(m.todos[0]).toMatchObject({ title: 'Order solder paste', priority: 'high' });
    expect(m.myReminders[0]).toEqual({ title: 'Renew the insurance', date: '2026-07-30' });
    expect(m.emotions).toMatchObject({ energy: 70, worry: 40 });
    expect(m.events).toHaveLength(2);
    expect(m.lessons).toHaveLength(1);
    expect(createdTasks).toHaveLength(0); // nothing saved by mining
    expect(doneTasks).toHaveLength(0);
  });

  it('links a delegation ONLY on an exact contact match — never a guess', async () => {
    const { svc } = make(RICH);
    const m = await svc.mine('2026-07-22');
    const mad = m.delegations.find((d) => d.contactName === 'Madhuri')!;
    const stranger = m.delegations.find((d) => d.contactName === 'Someone New')!;
    expect(mad.contactId).toBe('c-mad');
    expect(stranger.contactId).toBeNull();
    expect(m.promises[0]).toMatchObject({ to: 'Srikar', contactId: 'c-sri', date: '2026-07-25' });
  });

  it('does not re-propose work that is already logged', async () => {
    const { svc } = make(RICH, { existingTitles: ['Fixed the QC checklist for the line'] });
    const m = await svc.mine('2026-07-22');
    expect(m.done).toHaveLength(0); // overlaps the logged task
  });

  it('an unparseable model reply yields an empty payload, never a crash', async () => {
    const { svc } = make('sorry, plain prose');
    const m = await svc.mine('2026-07-22');
    expect(m.hasStory).toBe(true);
    expect(m.done).toEqual([]);
    expect(m.delegations).toEqual([]);
  });
});

describe('apply — exactly what was ticked, through the real doors (BEA-1051)', () => {
  it('creates the delegation as an owned task WITH a chase, and an unlinked one WITHOUT', async () => {
    const { svc, createdTasks, chases } = make(RICH);
    await svc.apply('2026-07-22', {
      delegations: [
        { contactName: 'Madhuri', contactId: 'c-mad', title: 'Send the Focus ERP report', chase: true },
        { contactName: 'Someone New', contactId: null, title: 'Paint the stall banners', chase: true },
      ],
    });
    expect(createdTasks).toHaveLength(2);
    expect(createdTasks[0]).toMatchObject({ ownerContactId: 'c-mad', party: 'Madhuri' });
    expect(createdTasks[1].ownerContactId).toBeUndefined(); // unlinked person: display text only
    expect(chases).toHaveLength(1); // no contact, no chase — never message a guessed number
    expect(chases[0]).toMatchObject({ contactId: 'c-mad', repeat: 'daily' });
  });

  it('a promise becomes a high-priority task carrying its promised date', async () => {
    const { svc, createdTasks } = make(RICH);
    await svc.apply('2026-07-22', { promises: [{ to: 'Srikar', contactId: 'c-sri', what: 'Pay the pending invoice', date: '2026-07-25' }] });
    expect(createdTasks[0]).toMatchObject({ title: 'Pay the pending invoice', priority: 'high', promisedFor: '2026-07-25' });
  });

  it('emotions land on the story; events replace prior mined ones; lessons reach the Lab', async () => {
    const { svc, storyUpdates, dayEvents, findings } = make(RICH);
    const counts = await svc.apply('2026-07-22', {
      emotions: { lifted: ['x'], drained: [], energy: 70, worry: 40, feeling: 'ok' },
      events: [{ at: 'morning', title: 'Factory' }],
      lessons: ['Late nights eat mornings'],
    });
    expect(counts).toMatchObject({ emotions: 1, events: 1, lessons: 1 });
    expect(JSON.parse(storyUpdates[0].emotions).energy).toBe(70);
    expect(dayEvents[0]).toMatchObject({ day: '2026-07-22', title: 'Factory', source: 'story' });
    expect(findings[0]).toMatchObject({ statement: 'Late nights eat mornings', status: 'proposed', firstSeenDay: '2026-07-22' });
  });

  it('applying an empty pick creates nothing', async () => {
    const { svc, createdTasks, doneTasks, chases } = make(RICH);
    const counts = await svc.apply('2026-07-22', {});
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
    expect(createdTasks.length + doneTasks.length + chases.length).toBe(0);
  });
});
