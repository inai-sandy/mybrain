import { DailyService } from './daily.service';

function makeService(opts: { llmText?: string | null } = {}) {
  const stories: any[] = [];
  const notes: any[] = [];
  const tasks: any[] = [];
  const summaries: any[] = [];
  let seq = 0;
  const enqueued: any[] = [];
  const prisma: any = {
    setting: { findUnique: async () => null },
    story: {
      findFirst: async ({ where }: any) => stories.filter((s) => s.day === where.day).slice(-1)[0] || null,
      create: async ({ data }: any) => {
        const row = { id: `s${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        stories.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const s = stories.find((x) => x.id === where.id);
        Object.assign(s, data, { updatedAt: new Date() });
        return s;
      },
    },
    dayNote: {
      create: async ({ data }: any) => {
        const row = { id: `n${++seq}`, createdAt: new Date(), ...data };
        notes.push(row);
        return row;
      },
      findMany: async ({ where }: any) => notes.filter((n) => n.day === where.day),
      delete: async ({ where }: any) => {
        const i = notes.findIndex((n) => n.id === where.id);
        if (i >= 0) notes.splice(i, 1);
        return {};
      },
    },
    task: {
      findMany: async ({ where }: any = {}) => tasks.filter((t) => (!where?.day || t.day === where.day) && (!where?.status || t.status === where.status)),
    },
    item: { findMany: async () => [] },
    idea: { findMany: async () => [] },
    skill: { findMany: async () => [] },
    brainDump: { findMany: async () => [] },
    daySummary: {
      findUnique: async ({ where }: any) => summaries.find((s) => s.day === where.day) || null,
      upsert: async ({ where, create, update }: any) => {
        const ex = summaries.find((s) => s.day === where.day);
        if (ex) {
          Object.assign(ex, update, { updatedAt: new Date() });
          return ex;
        }
        const row = { id: `sum${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        summaries.push(row);
        return row;
      },
    },
  };
  const llm: any = { completeWith: async () => (opts.llmText === undefined ? 'You had a solid day.' : opts.llmText) };
  const memory: any = { enqueue: async (text: string, o: any) => enqueued.push({ text, o }) };
  const tasksSvc: any = { getModel: async () => ({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }) };
  return { svc: new DailyService(prisma, llm, memory, tasksSvc), stories, notes, tasks, summaries, enqueued };
}

describe('DailyService', () => {
  it('keeps one story per day — re-submitting updates in place', async () => {
    const { svc, stories } = makeService();
    await svc.submitStory('rough start to the day', 'app', '😐 Okay');
    const second = await svc.submitStory('actually it turned out great', 'app', '🤩 Great');
    expect(stories).toHaveLength(1);
    expect(second!.text).toContain('turned out great');
    expect(second!.mood).toBe('🤩 Great');
  });

  it('captures daytime notes and reports them in today()', async () => {
    const { svc } = makeService();
    await svc.addNote('shipped the tasks feature');
    await svc.addNote('about to call the accountant');
    const t = await svc.today();
    expect(t.notes).toHaveLength(2);
    expect(t.storyDone).toBe(false);
  });

  it('today() flags storyDone once a story exists', async () => {
    const { svc } = makeService();
    await svc.submitStory('a full day');
    const t = await svc.today();
    expect(t.storyDone).toBe(true);
    expect(t.story!.text).toBe('a full day');
  });

  it('computes day stats from tasks (done count + minutes spent)', async () => {
    const { svc, tasks } = makeService();
    tasks.push({ id: 'a', day: '2026-06-07', status: 'done', actualMin: 30, estimateMin: 20 });
    tasks.push({ id: 'b', day: '2026-06-07', status: 'done', actualMin: 45, estimateMin: 60 });
    tasks.push({ id: 'c', day: '2026-06-07', status: 'open', estimateMin: 15 });
    const st = await svc.stats('2026-06-07');
    expect(st.tasksTotal).toBe(3);
    expect(st.tasksDone).toBe(2);
    expect(st.tasksOpen).toBe(1);
    expect(st.minutesSpent).toBe(75);
  });

  it('generates a day summary and indexes it to memory stamped "activity"', async () => {
    const { svc, summaries, enqueued } = makeService({ llmText: 'You finished the proposal and felt good.' });
    const out = await svc.generateSummary('2026-06-07');
    expect(out.text).toContain('proposal');
    expect(summaries).toHaveLength(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].o.tags).toEqual(['activity']);
  });

  it('falls back to a deterministic summary if the LLM is unavailable', async () => {
    const { svc } = makeService({ llmText: null });
    const out = await svc.generateSummary('2026-06-07');
    expect(out.text).toMatch(/finished/i);
  });
});
