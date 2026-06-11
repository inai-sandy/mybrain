import { MentorService } from './mentor.service';

function makeService(llmText: string | null) {
  const focus: any[] = [];
  const mentorDays: any[] = [];
  const dayStories: any[] = [];
  const stories: any[] = [];
  const tasks: any[] = [];
  const summaries: any[] = [];
  const weeklies: any[] = [];
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
      findMany: async ({ where, orderBy, take }: any = {}) => {
        let rows = mentorDays.filter((m) => (!where?.day?.gte || m.day >= where.day.gte) && (!where?.day?.lt || m.day < where.day.lt));
        rows = rows.sort((a, b) => (orderBy?.day === 'desc' ? b.day.localeCompare(a.day) : a.day.localeCompare(b.day)));
        return take ? rows.slice(0, take) : rows;
      },
      findFirst: async ({ where, orderBy }: any = {}) => {
        const rows = mentorDays
          .filter((m) => !where?.day?.lt || m.day < where.day.lt)
          .sort((a, b) => (orderBy?.day === 'desc' ? b.day.localeCompare(a.day) : a.day.localeCompare(b.day)));
        return rows[0] || null;
      },
      findUnique: async ({ where }: any) => mentorDays.find((m) => m.day === where.day) || null,
      upsert: async ({ where, create, update }: any) => {
        const ex = mentorDays.find((m) => m.day === where.day);
        if (ex) { Object.assign(ex, update, { updatedAt: new Date() }); return ex; }
        const row = { id: `m${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        mentorDays.push(row);
        return row;
      },
    },
    dayStory: {
      findUnique: async ({ where }: any) => dayStories.find((s) => s.day === where.day) || null,
      findMany: async ({ where }: any = {}) => dayStories.filter((s) => (!where?.day?.gte || s.day >= where.day.gte) && (!where?.day?.lte || s.day <= where.day.lte)),
    },
    story: { findFirst: async ({ where }: any) => stories.filter((s) => s.day === where.day).slice(-1)[0] || null, findMany: async () => stories.slice() },
    task: {
      findMany: async ({ where }: any = {}) =>
        tasks.filter((t) => {
          const d = where?.day;
          if (d === undefined) return true;
          if (typeof d === 'string') return t.day === d;
          return (!d.gte || t.day >= d.gte) && (!d.lte || t.day <= d.lte);
        }),
    },
    daySummary: { findMany: async ({ where }: any = {}) => summaries.filter((s) => (!where?.day?.gte || s.day >= where.day.gte) && (!where?.day?.lte || s.day <= where.day.lte)) },
    personMention: { findMany: async () => [] },
    weeklyReview: {
      findUnique: async ({ where }: any) => weeklies.find((w) => w.weekStart === where.weekStart) || null,
      findFirst: async ({ where, orderBy }: any = {}) => {
        const rows = weeklies
          .filter((w) => !where?.weekStart?.lt || w.weekStart < where.weekStart.lt)
          .sort((a, b) => (orderBy?.weekStart === 'desc' ? b.weekStart.localeCompare(a.weekStart) : a.weekStart.localeCompare(b.weekStart)));
        return rows[0] || null;
      },
      findMany: async ({ take }: any = {}) => weeklies.slice(0, take || undefined),
      count: async () => weeklies.length,
      upsert: async ({ where, create, update }: any) => {
        const ex = weeklies.find((w) => w.weekStart === where.weekStart);
        if (ex) { Object.assign(ex, update, { updatedAt: new Date() }); return ex; }
        const row = { id: `w${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        weeklies.push(row);
        return row;
      },
    },
  };
  const llm: any = { completeWith: jest.fn(async () => llmText) };
  const prompts: any = { get: async (k: string) => `[${k}]` };
  const tasksSvc: any = { listModels: async () => [] };
  return { svc: new MentorService(prisma, llm, prompts, tasksSvc), llm, focus, mentorDays, dayStories, stories, tasks, summaries, weeklies, settings };
}

describe('MentorService', () => {
  describe('weekly review', () => {
    it('weekStartOf maps any day to its Monday (Mon..Sun weeks)', () => {
      const { svc } = makeService(null);
      expect(svc.weekStartOf('2026-06-08')).toBe('2026-06-08'); // a Monday
      expect(svc.weekStartOf('2026-06-11')).toBe('2026-06-08'); // Thursday
      expect(svc.weekStartOf('2026-06-14')).toBe('2026-06-08'); // Sunday belongs to the week it ends
    });

    it('writes the weekly review with pattern + experiment and flags the Telegram push', async () => {
      const { svc, summaries, dayStories, settings, weeklies } = makeService('{"review":"A strong week — Beakn moved.","pattern":"Days that started with a dump ended above 70.","experiment":"Dump before 8 AM all 7 days."}');
      summaries.push({ day: '2026-06-08', text: 'Shipped the proposal.' });
      dayStories.push({ day: '2026-06-09', text: 'Good day', moodScore: 75 });
      const w = await svc.generateWeeklyReview('2026-06-08');
      expect(w!.text).toContain('strong week');
      expect(w!.pattern).toContain('dump');
      expect(w!.experiment).toContain('8 AM');
      expect(weeklies).toHaveLength(1);
      expect(settings['telegram.pushWeekly']).toBe('2026-06-08');
    });

    it('returns null for a week with no recorded data (and writes nothing)', async () => {
      const { svc, weeklies, llm } = makeService('{"review":"should never be called"}');
      expect(await svc.generateWeeklyReview('2026-01-05')).toBeNull();
      expect(weeklies).toHaveLength(0);
      expect(llm.completeWith).not.toHaveBeenCalled();
    });
  });

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

  it('ensureFreshRead re-runs a read that predates its Story of the Day, and skips a fresh one', async () => {
    const { svc, llm, mentorDays, dayStories } = makeService('{"adherenceScore":70,"guidance":"Fresh end-of-day read."}');
    // stale: read written at 1 AM, story written at 11:58 PM the same day
    mentorDays.push({ day: '2026-06-09', adherenceScore: 72, moodScore: null, guidance: 'Stale 1 AM read.', updatedAt: new Date('2026-06-08T19:30:00Z') });
    dayStories.push({ day: '2026-06-09', text: 'The real day.', moodScore: 60, createdAt: new Date('2026-06-09T18:28:00Z') });
    await svc.ensureFreshRead('2026-06-09');
    expect(llm.completeWith).toHaveBeenCalledTimes(1); // re-ran
    expect(mentorDays.find((m) => m.day === '2026-06-09')!.guidance).toContain('Fresh end-of-day');
    // now it's fresh (updatedAt > story.createdAt) → a second ensure does nothing
    await svc.ensureFreshRead('2026-06-09');
    expect(llm.completeWith).toHaveBeenCalledTimes(1);
  });

  it('getDay returns a past day with the previous read\'s score for the delta', async () => {
    const { svc, mentorDays } = makeService(null);
    mentorDays.push({ day: '2026-06-07', adherenceScore: 40, moodScore: 50, guidance: 'Day one.' });
    mentorDays.push({ day: '2026-06-08', adherenceScore: 72, moodScore: 80, guidance: 'Day two.' });
    const d = await svc.getDay('2026-06-08');
    expect(d!.guidance).toBe('Day two.');
    expect(d!.prev).toEqual({ day: '2026-06-07', adherenceScore: 40 });
    expect(await svc.getDay('2026-06-01')).toBeNull(); // no read that day
  });

  it('the nightly read is told yesterday\'s score and never reads its own same-day draft as yesterday', async () => {
    const { svc, llm, mentorDays, dayStories } = makeService('{"adherenceScore":72,"guidance":"Yesterday 40, today 72 — the Beakn push did it."}');
    mentorDays.push({ day: '2026-06-07', adherenceScore: 40, moodScore: null, guidance: 'Push the Excel file.' });
    mentorDays.push({ day: '2026-06-08', adherenceScore: 55, moodScore: null, guidance: 'Old same-day draft.' });
    dayStories.push({ day: '2026-06-08', text: 'Big Beakn day.', moodScore: 80 });
    await svc.runMentorDay('2026-06-08', true); // force re-run of a day that already has a draft
    const prompt: string = llm.completeWith.mock.calls[0][1];
    expect(prompt).toContain('Score: 40/100 (2026-06-07)'); // yesterday = the prior day...
    expect(prompt).not.toContain('Old same-day draft'); // ...never its own earlier draft
  });
});
