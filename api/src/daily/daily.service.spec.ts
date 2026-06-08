import { DailyService } from './daily.service';

function makeService(opts: { llmText?: string | null } = {}) {
  const stories: any[] = [];
  const notes: any[] = [];
  const tasks: any[] = [];
  const summaries: any[] = [];
  const dayStories: any[] = [];
  const suggestions: any[] = [];
  const dumps: any[] = [];
  const insights: any[] = [];
  const settings: Record<string, string> = {};
  let seq = 0;
  const enqueued: any[] = [];
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create.value;
        return { key: where.key, value: settings[where.key] };
      },
    },
    story: {
      findFirst: async ({ where }: any) => stories.filter((s) => s.day === where.day).slice(-1)[0] || null,
      findMany: async ({ where }: any = {}) => stories.filter((s) => !where?.day?.gte || s.day >= where.day.gte),
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
      findMany: async ({ where }: any = {}) =>
        tasks.filter((t) => {
          if (where?.status && t.status !== where.status) return false;
          const d = where?.day;
          if (d !== undefined) {
            if (typeof d === 'string') return t.day === d;
            if (d.gte && !(t.day && t.day >= d.gte)) return false;
          }
          return true;
        }),
      create: async ({ data }: any) => {
        const row = { id: `t${++seq}`, createdAt: new Date(), status: 'open', ...data };
        tasks.push(row);
        return row;
      },
    },
    suggestedTask: {
      findMany: async ({ where }: any = {}) => suggestions.filter((s) => (where?.forDay === undefined || s.forDay === where.forDay) && (where?.status === undefined || s.status === where.status)),
      findUnique: async ({ where }: any) => suggestions.find((s) => s.id === where.id) || null,
      create: async ({ data }: any) => {
        const row = { id: `sg${++seq}`, createdAt: new Date(), status: 'pending', ...data };
        suggestions.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const s = suggestions.find((x) => x.id === where.id);
        if (s) Object.assign(s, data);
        return s;
      },
      deleteMany: async ({ where }: any) => {
        for (let i = suggestions.length - 1; i >= 0; i--) {
          const s = suggestions[i];
          if ((where?.forDay === undefined || s.forDay === where.forDay) && (where?.status === undefined || s.status === where.status)) suggestions.splice(i, 1);
        }
        return {};
      },
    },
    item: { findMany: async () => [] },
    idea: { findMany: async () => [] },
    skill: { findMany: async () => [] },
    personalityInsight: {
      findMany: async ({ where }: any = {}) => insights.filter((i) => (!where?.status?.not || i.status !== where.status.not) && (where?.generation === undefined || i.generation === where.generation)),
      findFirst: async () => insights.slice().sort((a, b) => b.generation - a.generation)[0] || null,
      findUnique: async ({ where }: any) => insights.find((i) => i.id === where.id) || null,
      create: async ({ data }: any) => {
        const row = { id: `pi${++seq}`, createdAt: new Date(), status: 'pending', ...data };
        insights.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const i = insights.find((x) => x.id === where.id);
        Object.assign(i, data);
        return i;
      },
    },
    brainDump: {
      findMany: async ({ where }: any = {}) => {
        const filtered = dumps.filter((d) => !where?.day?.gte || d.day >= where.day.gte);
        return filtered;
      },
    },
    daySummary: {
      findMany: async () => summaries.slice(),
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
    dayStory: {
      findUnique: async ({ where }: any) => dayStories.find((s) => s.day === where.day) || null,
      upsert: async ({ where, create, update }: any) => {
        const ex = dayStories.find((s) => s.day === where.day);
        if (ex) {
          Object.assign(ex, update, { updatedAt: new Date() });
          return ex;
        }
        const row = { id: `ds${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        dayStories.push(row);
        return row;
      },
    },
  };
  const llm: any = { completeWith: async () => (opts.llmText === undefined ? 'You had a solid day.' : opts.llmText) };
  const memory: any = { enqueue: async (text: string, o: any) => enqueued.push({ text, o }) };
  const tasksSvc: any = { getModel: async () => ({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }), listModels: async () => [] };
  const prompts: any = { get: async (k: string) => `[${k} instruction]` };
  return { svc: new DailyService(prisma, llm, memory, tasksSvc, prompts), stories, notes, tasks, summaries, dayStories, suggestions, dumps, insights, enqueued };
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

  it('weaves the Story of the Day (JSON with mood score) and stores it in both memory stores', async () => {
    const { svc, dayStories, enqueued } = makeService({ llmText: '{"story":"You pushed through a hard morning and landed the proposal.","mood":"determined","moodScore":78}' });
    const out = await svc.generateDayStory('2026-06-07');
    expect(out.text).toContain('proposal');
    expect(out.mood).toBe('determined');
    expect(out.moodScore).toBe(78);
    expect(dayStories).toHaveLength(1);
    // stored to memory (RAG + SuperMemory) stamped "activity" so the sync never re-imports it
    expect(enqueued[0].o.tags).toEqual(['activity']);
    expect(enqueued[0].text).toContain('Story of the Day');
  });

  it('keeps the model prose as the story when it does not return JSON', async () => {
    const { svc } = makeService({ llmText: 'A plain, heartfelt paragraph about the day.' });
    const out = await svc.generateDayStory('2026-06-07');
    expect(out.text).toContain('heartfelt');
    expect(out.moodScore).toBeNull();
  });

  it('suggests tasks FOR a day by reading the PREVIOUS day\'s story, and approves one into a real task', async () => {
    const { svc, tasks } = makeService({ llmText: '{"tasks":[{"title":"Send Srikar the pricing","category":"Beakn","reason":"Next step after today"},{"title":"Book gym slot","category":"Health","reason":"You said you would"}]}' });
    // target = the 8th → reads the 7th's story/tasks
    const made = await svc.generateSuggestions('2026-06-08');
    expect(made).toHaveLength(2);
    expect(made[0].forDay).toBe('2026-06-08');
    const list = await svc.listSuggestions('2026-06-08');
    expect(list.suggestions).toHaveLength(2);
    const r = await svc.addSuggestion(made[0].id);
    expect(r!.ok).toBe(true);
    expect(tasks.find((t) => t.title === 'Send Srikar the pricing' && t.day === '2026-06-08')).toBeTruthy();
    const after = await svc.listSuggestions('2026-06-08');
    expect(after.suggestions).toHaveLength(1); // the added one is no longer pending
  });

  it('drops suggestions that duplicate a task already open (read from the previous day)', async () => {
    const { svc, tasks } = makeService({ llmText: '{"tasks":[{"title":"Complete the product Excel file"},{"title":"Call the new supplier about samples"}]}' });
    tasks.push({ id: 'o1', day: '2026-06-07', status: 'open', title: 'Complete product Excel file' }); // open on the source day
    const made = await svc.generateSuggestions('2026-06-08'); // target 8th → source 7th
    expect(made).toHaveLength(1);
    expect(made[0].title).toContain('supplier');
  });

  it('regenerating suggestions replaces only the still-pending picks', async () => {
    const { svc } = makeService({ llmText: '{"tasks":[{"title":"First idea"}]}' });
    const first = await svc.generateSuggestions('2026-06-08');
    await svc.addSuggestion(first[0].id); // user accepted this one
    // a second run shouldn't wipe the accepted one, only pending
    await svc.generateSuggestions('2026-06-08');
    const list = await svc.listSuggestions('2026-06-08');
    expect(list.suggestions.every((s) => s.status === 'pending')).toBe(true);
  });

  it('dashboard aggregates follow-through, time-by-category and dump streak', async () => {
    const { svc, tasks, dumps } = makeService();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const yest = new Date(today + 'T12:00:00Z');
    yest.setUTCDate(yest.getUTCDate() - 1);
    const yKey = yest.toISOString().slice(0, 10);
    tasks.push({ day: today, status: 'done', category: 'Beakn', actualMin: 60, estimateMin: 30 });
    tasks.push({ day: today, status: 'done', category: 'Admin', actualMin: 20, estimateMin: 20 });
    tasks.push({ day: today, status: 'open', category: 'Beakn', estimateMin: 40 });
    dumps.push({ day: today });
    dumps.push({ day: yKey });
    const d = await svc.dashboard(30);
    expect(d.totals.tasksTotal).toBe(3);
    expect(d.totals.tasksDone).toBe(2);
    expect(d.totals.followThrough).toBe(67);
    expect(d.categoryTime[0].category).toBe('Beakn'); // 60 > 20
    expect(d.streak).toBe(2); // today + yesterday
    expect(d.estimateVsActual.actual).toBe(80);
  });

  it('keeps the personality read locked until 10 active days', async () => {
    const { svc, dumps } = makeService();
    for (let i = 0; i < 4; i++) dumps.push({ day: `2026-05-0${i + 1}` });
    const p = await svc.getPersonality();
    expect(p.daysCovered).toBe(4);
    expect(p.unlocked).toBe(false);
    expect(p.insights).toHaveLength(0);
  });

  it('builds evidence-grounded insights once unlocked, and lets the user validate them', async () => {
    const persona = JSON.stringify({
      summary: 'You ship consistently but dodge admin work.',
      insights: [
        { dimension: 'Follow-through', claim: 'You finish most of what you plan.', evidence: '67% follow-through' },
        { dimension: 'Procrastination', claim: 'You avoid admin tasks.', evidence: 'admin carried 3 days' },
      ],
    });
    const { svc, dumps, insights } = makeService({ llmText: persona });
    for (let i = 1; i <= 12; i++) dumps.push({ day: `2026-05-${String(i).padStart(2, '0')}` });

    const p = await svc.regeneratePersonality();
    expect(p.unlocked).toBe(true);
    expect(p.summary).toContain('admin');
    expect(p.insights.length).toBe(2);

    const id = insights[0].id;
    const v = await svc.validateInsight(id, 'confirmed');
    expect(v!.status).toBe('confirmed');
    const after = await svc.getPersonality();
    expect(after.insights.find((x: any) => x.id === id)!.status).toBe('confirmed');
  });

  it('calendar reports per-day done/total plus dumped/story flags', async () => {
    const { svc, tasks, dumps, stories } = makeService();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    tasks.push({ day: today, status: 'done' });
    tasks.push({ day: today, status: 'open' });
    dumps.push({ day: today });
    stories.push({ day: today, rawText: 'x', createdAt: new Date(), updatedAt: new Date() });
    const c = await svc.calendar(3);
    const t = c.days.find((x: any) => x.day === today);
    expect(t.done).toBe(1);
    expect(t.total).toBe(2);
    expect(t.dumped).toBe(true);
    expect(t.story).toBe(true);
  });
});
