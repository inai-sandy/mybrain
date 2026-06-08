import { MentorService } from './mentor.service';

function makeService(llmText: string | null) {
  const focus: any[] = [];
  const mentorDays: any[] = [];
  const dayStories: any[] = [];
  const stories: any[] = [];
  const tasks: any[] = [];
  const settings: Record<string, string> = {};
  let seq = 0;
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => { settings[where.key] = update?.value ?? create.value; return { key: where.key, value: settings[where.key] }; },
    },
    focusArea: {
      findMany: async ({ where }: any = {}) => focus.filter((f) => (!where?.status?.not || f.status !== where.status.not) && (where?.status === undefined || where.status?.not !== undefined || f.status === where.status)),
      findUnique: async ({ where }: any) => focus.find((f) => f.id === where.id) || null,
      count: async ({ where }: any = {}) => focus.filter((f) => !where?.status?.not || f.status !== where.status.not).length,
      create: async ({ data }: any) => { const row = { id: `f${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...data }; focus.push(row); return row; },
      update: async ({ where, data }: any) => { const f = focus.find((x) => x.id === where.id); Object.assign(f, data); return f; },
      deleteMany: async ({ where }: any = {}) => {
        for (let i = focus.length - 1; i >= 0; i--) {
          const f = focus[i];
          if ((where?.status === undefined || f.status === where.status) && (where?.source === undefined || f.source === where.source)) focus.splice(i, 1);
        }
        return {};
      },
    },
    mentorDay: {
      findMany: async ({ where }: any = {}) => mentorDays.filter((m) => !where?.day?.gte || m.day >= where.day.gte).sort((a, b) => a.day.localeCompare(b.day)),
      findUnique: async ({ where }: any) => mentorDays.find((m) => m.day === where.day) || null,
      upsert: async ({ where, create, update }: any) => {
        const ex = mentorDays.find((m) => m.day === where.day);
        if (ex) { Object.assign(ex, update); return ex; }
        const row = { id: `m${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        mentorDays.push(row);
        return row;
      },
    },
    dayStory: { findUnique: async ({ where }: any) => dayStories.find((s) => s.day === where.day) || null, findMany: async () => dayStories.slice() },
    story: { findFirst: async ({ where }: any) => stories.filter((s) => s.day === where.day).slice(-1)[0] || null, findMany: async () => stories.slice() },
    task: { findMany: async ({ where }: any = {}) => tasks.filter((t) => !where?.day || t.day === where.day) },
  };
  const llm: any = { completeWith: async () => llmText };
  const prompts: any = { get: async (k: string) => `[${k}]` };
  const tasksSvc: any = { listModels: async () => [] };
  return { svc: new MentorService(prisma, llm, prompts, tasksSvc), focus, mentorDays, dayStories, stories, tasks };
}

describe('MentorService', () => {
  it('derives focus areas as "proposed" and skips duplicates of existing ones', async () => {
    const { svc, focus } = makeService('{"focusAreas":[{"title":"Ship Beakn milestones","description":"core work"},{"title":"Protect mornings"}]}');
    focus.push({ id: 'x', title: 'Protect mornings', status: 'active' });
    const made = await svc.deriveFocusAreas();
    expect(made).toHaveLength(1); // the duplicate "Protect mornings" is skipped
    expect(made[0].title).toBe('Ship Beakn milestones');
    expect(made[0].status).toBe('proposed');
  });

  it('user can add a focus area (active) and confirm a proposed one', async () => {
    const { svc } = makeService(null);
    const f = await svc.createFocusArea('Consistent gym');
    expect(f!.status).toBe('active');
    expect(f!.source).toBe('user');
    const list1 = await svc.listFocusAreas();
    expect(list1.active).toHaveLength(1);
  });

  it('writes a daily mentor read with an adherence score from the day', async () => {
    const { svc, dayStories, focus, mentorDays } = makeService('{"adherenceScore":72,"guidance":"You leaned into Beakn today — keep that, but the gym is slipping."}');
    focus.push({ id: 'a', title: 'Ship Beakn', status: 'active' });
    dayStories.push({ day: '2026-06-08', text: 'Big day on Beakn.', moodScore: 80 });
    const m = await svc.runMentorDay('2026-06-08');
    expect(m!.adherenceScore).toBe(72);
    expect(m!.moodScore).toBe(80);
    expect(m!.guidance).toContain('Beakn');
    expect(mentorDays).toHaveLength(1);
  });

  it('overview returns focus areas, latest guidance and a trend series', async () => {
    const { svc, mentorDays, focus } = makeService(null);
    focus.push({ id: 'a', title: 'Ship Beakn', status: 'active' });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    mentorDays.push({ day: today, adherenceScore: 60, moodScore: 70, guidance: 'Keep going.' });
    const o = await svc.overview();
    expect(o.focusAreas.active).toHaveLength(1);
    expect(o.latest!.adherenceScore).toBe(60);
    expect(o.trend).toHaveLength(1);
    expect(o.avgAdherence).toBe(60);
  });

  it('returns null guidance when there is nothing to mentor on', async () => {
    const { svc } = makeService(null);
    const m = await svc.runMentorDay('2026-06-08');
    expect(m).toBeNull();
  });
});
