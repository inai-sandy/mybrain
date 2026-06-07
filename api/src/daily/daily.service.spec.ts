import { DailyService } from './daily.service';

function makeService(opts: { llmText?: string | null } = {}) {
  const stories: any[] = [];
  const notes: any[] = [];
  const tasks: any[] = [];
  const summaries: any[] = [];
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
  };
  const llm: any = { completeWith: async () => (opts.llmText === undefined ? 'You had a solid day.' : opts.llmText) };
  const memory: any = { enqueue: async (text: string, o: any) => enqueued.push({ text, o }) };
  const tasksSvc: any = { getModel: async () => ({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }) };
  return { svc: new DailyService(prisma, llm, memory, tasksSvc), stories, notes, tasks, summaries, dumps, insights, enqueued };
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
