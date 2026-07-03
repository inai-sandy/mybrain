import { DailyService } from './daily.service';

// The service computes "today" in the user's timezone (Asia/Kolkata), so tests must too —
// using UTC (new Date().toISOString()) flakes near IST midnight (passes by day, fails by night).
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function makeService(opts: { llmText?: string | null } = {}) {
  const stories: any[] = [];
  const notes: any[] = [];
  const tasks: any[] = [];
  const summaries: any[] = [];
  const dayStories: any[] = [];
  const monthStories: any[] = [];
  const yearStories: any[] = [];
  const peopleMentions: any[] = [];
  const dayCloses: any[] = [];
  const suggestions: any[] = [];
  const dumps: any[] = [];
  const insights: any[] = [];
  const settings: Record<string, string> = {};
  let seq = 0;
  const enqueued: any[] = [];
  const prisma: any = {
    mindRun: { create: async () => ({}) },
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create.value;
        return { key: where.key, value: settings[where.key] };
      },
    },
    story: {
      findFirst: async ({ where }: any) => stories.filter((s) => s.day === where.day).slice(-1)[0] || null,
      findMany: async ({ where }: any = {}) =>
        stories.filter(
          (s) =>
            (!where?.day?.gte || s.day >= where.day.gte) &&
            (!where?.day?.lte || s.day <= where.day.lte) &&
            (!where?.day?.lt || s.day < where.day.lt),
        ),
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
            if (d.lt && !(t.day && t.day < d.lt)) return false;
            if (d.lte && !(t.day && t.day <= d.lte)) return false;
          }
          return true;
        }),
      count: async ({ where }: any = {}) =>
        tasks.filter((t) => (!where?.status || t.status === where.status) && (where?.day === undefined || t.day === where.day)).length,
      create: async ({ data }: any) => {
        const row = { id: `t${++seq}`, createdAt: new Date(), status: 'open', ...data };
        tasks.push(row);
        return row;
      },
    },
    dayClose: {
      findUnique: async ({ where }: any) => dayCloses.find((c) => c.day === where.day) || null,
      findMany: async () => dayCloses.slice(),
      upsert: async ({ where, create, update }: any) => {
        const ex = dayCloses.find((c) => c.day === where.day);
        if (ex) {
          Object.assign(ex, update);
          return ex;
        }
        const row = { id: `dc${++seq}`, closedAt: new Date(), ...create };
        dayCloses.push(row);
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
      findMany: async ({ where }: any = {}) => dayStories.filter((s) => (!where?.day?.gte || s.day >= where.day.gte) && (!where?.day?.lte || s.day <= where.day.lte)),
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
    monthStory: {
      findUnique: async ({ where }: any) => monthStories.find((m) => m.month === where.month) || null,
      findMany: async ({ where }: any = {}) => monthStories.filter((m) => (!where?.month?.gte || m.month >= where.month.gte) && (!where?.month?.lte || m.month <= where.month.lte)),
      upsert: async ({ where, create, update }: any) => {
        const ex = monthStories.find((m) => m.month === where.month);
        if (ex) { Object.assign(ex, update, { updatedAt: new Date() }); return ex; }
        const row = { id: `ms${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        monthStories.push(row);
        return row;
      },
    },
    weeklyReview: { findMany: async () => [] },
    contact: {
      findMany: async () => [],
    },
    personMention: {
      findMany: async ({ where }: any = {}) => peopleMentions.filter((m) => !where?.name || m.name === where.name),
      deleteMany: async ({ where }: any = {}) => {
        for (let i = peopleMentions.length - 1; i >= 0; i--) if (!where?.name || peopleMentions[i].name === where.name) peopleMentions.splice(i, 1);
        return {};
      },
      upsert: async ({ where, create }: any) => {
        const k = where.name_day;
        const ex = peopleMentions.find((m) => m.name === k.name && m.day === k.day);
        if (ex) return ex;
        const row = { id: `pm${++seq}`, createdAt: new Date(), ...create };
        peopleMentions.push(row);
        return row;
      },
    },
    yearStory: {
      findUnique: async ({ where }: any) => yearStories.find((y) => y.year === where.year) || null,
      upsert: async ({ where, create, update }: any) => {
        const ex = yearStories.find((y) => y.year === where.year);
        if (ex) { Object.assign(ex, update, { updatedAt: new Date() }); return ex; }
        const row = { id: `ys${++seq}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        yearStories.push(row);
        return row;
      },
    },
  };
  const llmText = async () => (opts.llmText === undefined ? 'You had a solid day.' : opts.llmText);
  const llm: any = {
    completeWith: jest.fn(llmText),
    completeWithModel: jest.fn(async () => ({ text: await llmText(), model: 'test-model' })),
  };
  const memory: any = {
    enqueue: async (text: string, o: any) => enqueued.push({ text, o }),
    indexEntity: async (opts: any) => enqueued.push({ text: opts.content, o: { title: opts.title, tags: opts.tags } }),
    deleteDoc: async () => undefined,
  };
  const rolledCalls: any[] = [];
  const tasksSvc: any = {
    getModel: async () => ({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }),
    listModels: async () => [],
    rollDayForward: async (fromDay: string, toDay: string) => {
      rolledCalls.push({ fromDay, toDay });
      const open = tasks.filter((t) => t.status === 'open' && t.day === fromDay);
      open.forEach((t) => { t.day = toDay; t.rolloverCount = (t.rolloverCount || 0) + 1; });
      return { rolled: open.length };
    },
  };
  const mentorCalls: any[] = [];
  const mentorSvc: any = { runMentorDay: async (day: string, force: boolean) => { mentorCalls.push({ day, force }); return { day }; }, listFocusAreas: async () => ({ active: [], proposed: [] }) };
  const prompts: any = { get: async (k: string) => `[${k} instruction]` };
  const mindCalls: any[] = [];
  const mindSvc: any = { learnDay: async (day: string) => { mindCalls.push(day); return { proposed: 0, reinforced: 0 }; }, summaryForMentor: async () => '' };
  return { svc: new DailyService(prisma, llm, memory, tasksSvc, prompts, mentorSvc, mindSvc), stories, notes, tasks, summaries, dayStories, monthStories, suggestions, dumps, insights, enqueued, yearStories, peopleMentions, dayCloses, rolledCalls, mentorCalls, mindCalls, settings };
}

describe('DailyService', () => {
  describe('Story of the Month', () => {
    it('weaves a chapter from the month\'s day stories and indexes it to memory', async () => {
      const { svc, dayStories, monthStories, enqueued } = makeService({ llmText: '{"title":"The Month of Building","story":"May opened with doubt and closed with a shipped product."}' });
      dayStories.push({ day: '2026-05-03', text: 'Started the build.', moodScore: 60 }, { day: '2026-05-15', text: 'Hard week.', moodScore: 45 }, { day: '2026-05-28', text: 'Shipped it.', moodScore: 85 });
      const m = await svc.generateMonthStory('2026-05');
      expect(m!.title).toBe('The Month of Building');
      expect(m!.text).toContain('shipped product');
      expect(monthStories).toHaveLength(1);
      expect(enqueued.some((e) => e.o.title === 'Story of the Month 2026-05')).toBe(true);
    });

    it('refuses a chapter for a month with fewer than 3 recorded days', async () => {
      const { svc, dayStories, monthStories } = makeService({ llmText: '{"story":"x"}' });
      dayStories.push({ day: '2026-04-10', text: 'one day' });
      expect(await svc.generateMonthStory('2026-04')).toBeNull();
      expect(monthStories).toHaveLength(0);
    });

    it('lists written chapters and months still waiting', async () => {
      const { svc, dayStories, monthStories } = makeService();
      monthStories.push({ month: '2026-05', title: 'T', text: 'x', createdAt: new Date(), updatedAt: new Date() });
      dayStories.push({ day: '2026-06-09', text: 'a' });
      const l = await svc.listMonths();
      expect(l.count).toBe(1);
      expect(l.pending).toEqual(['2026-06']);
    });
  });


    it('weaves the Story of the Year from the monthly chapters (partial while the year runs)', async () => {
      const { svc, monthStories, yearStories } = makeService({ llmText: '{"title":"The Year It Compounded","story":"The year opened slowly and ended with a system that knows you."}' });
      const yr = new Date().getFullYear();
      monthStories.push({ month: `${yr}-01`, title: 'Start', text: 'January.' }, { month: `${yr}-05`, title: 'Mid', text: 'May.' });
      const y = await svc.generateYearStory(String(yr));
      expect(y!.title).toBe('The Year It Compounded');
      expect(y!.partial).toBe(true); // generated during the running year
      expect(yearStories).toHaveLength(1);
    });

    it('returns null for a year with no chapters', async () => {
      const { svc } = makeService({ llmText: '{"story":"x"}' });
      expect(await svc.generateYearStory('2020')).toBeNull();
    });


  describe('people memory', () => {
    it('extracts people from his story, idempotent per name+day', async () => {
      const { svc, peopleMentions } = makeService({ llmText: '{"people":["Srikar","Kishore"]}' });
      await svc.extractPeople('2026-06-10', 'Met Srikar about pricing, then a long call with Kishore.');
      await svc.extractPeople('2026-06-10', 'Met Srikar about pricing, then a long call with Kishore.');
      expect(peopleMentions).toHaveLength(2); // re-running the same day adds nothing
    });

    it('aggregates the people overview with fading detection', async () => {
      const { svc, peopleMentions } = makeService();
      peopleMentions.push({ name: 'Srikar', day: '2026-06-10' }, { name: 'Srikar', day: '2026-06-11' }, { name: 'Amma', day: '2026-04-01' }, { name: 'Amma', day: '2026-04-05' });
      const o = await svc.peopleOverview();
      expect(o.count).toBe(2);
      expect(o.people[0].name).toBe('Srikar');
      expect(o.people.find((p: any) => p.name === 'Amma')!.fading).toBe(true);
    });
  });


    it('merges a duplicate person and remembers the alias for future extractions', async () => {
      const { svc, peopleMentions } = makeService({ llmText: '{"people":["Allison"]}' });
      peopleMentions.push({ name: 'Alisan', day: '2026-06-10' }, { name: 'Allison', day: '2026-06-11' }, { name: 'Allison', day: '2026-06-10' });
      const r = await svc.mergePeople('Allison', 'Alisan');
      expect(r!.merged).toBe(2);
      const names = peopleMentions.map((m: any) => m.name);
      expect(names.every((n: string) => n === 'Alisan')).toBe(true);
      expect(peopleMentions).toHaveLength(2); // June 10 deduped
      // future extraction of "Allison" lands as Alisan
      await svc.extractPeople('2026-06-12', 'Long call with Allison about the mounting plan.');
      expect(peopleMentions.find((m: any) => m.day === '2026-06-12')!.name).toBe('Alisan');
    });


    it('renames a person to a brand-new name (merge into a name with no rows)', async () => {
      const { svc, peopleMentions } = makeService();
      peopleMentions.push({ name: 'Alisan', day: '2026-06-10' }, { name: 'Alisan', day: '2026-06-11' });
      const r = await svc.mergePeople('Alisan', 'Alison K');
      expect(r!.merged).toBe(2);
      expect(peopleMentions.every((m: any) => m.name === 'Alison K')).toBe(true);
    });


    it('personDetail collects the task lines, story sentences and notes mentioning the person', async () => {
      const { svc, peopleMentions, stories, tasks, notes } = makeService();
      peopleMentions.push({ name: 'Srikar', day: '2026-06-11' });
      stories.push({ id: 's1', day: '2026-06-11', rawText: 'Long call with Srikar about payments. Then gym.', createdAt: new Date() });
      tasks.push({ id: 't1', day: '2026-06-11', title: 'Discuss installation charges with Srikar', status: 'done' });
      notes.push({ id: 'n1', day: '2026-06-11', text: 'Srikar asked for the revised quote' });
      const d = await svc.personDetail('Srikar');
      expect(d!.mentions).toBe(1);
      const types = d!.days[0].items.map((i: any) => i.type).sort();
      expect(types).toEqual(['note', 'story', 'task']);
      expect(d!.days[0].items.find((i: any) => i.type === 'story')!.text).toContain('payments');
      expect(d!.days[0].items.find((i: any) => i.type === 'story')!.text).not.toContain('gym');
    });


  it('weaves the two-sphere Story of the Day (professional + personal, separate moods)', async () => {
    const { svc, dayStories } = makeService({ llmText: '{"professional":{"story":"You closed the Srikar payment thread.","moodScore":72},"personal":{"story":"Dinner with the family felt unhurried.","moodScore":85},"mood":"settled","moodScore":78}' });
    const out = await svc.generateDayStory('2026-06-12');
    expect(out.text).toContain('Srikar');
    expect(out.personalText).toContain('family');
    expect(out.proMoodScore).toBe(72);
    expect(out.personalMoodScore).toBe(85);
    expect(out.moodScore).toBe(78);
    expect(dayStories).toHaveLength(1);
  });

  it('keeps the single-story shape working (no personal content -> no personal tab)', async () => {
    const { svc } = makeService({ llmText: '{"professional":{"story":"All work today.","moodScore":60},"personal":null,"mood":"steady","moodScore":60}' });
    const out = await svc.generateDayStory('2026-06-13');
    expect(out.text).toContain('All work');
    expect(out.personalText).toBeNull();
  });

  describe('day lifecycle — Close the day', () => {
    it('closeDay finalizes story + mentor + suggestions and rolls a past day\'s open tasks forward', async () => {
      const { svc, tasks, dayCloses, mentorCalls, rolledCalls, mindCalls } = makeService({ llmText: '{"story":"A real day, sealed.","mood":"settled","moodScore":70}' });
      const today = istToday();
      const past = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
      tasks.push({ id: 'a', day: past, status: 'open', title: 'leftover' }, { id: 'b', day: past, status: 'done', title: 'did it' });

      const r = await svc.closeDay(past, false);
      await new Promise((res) => setImmediate(res)); // let the background generate/mentor/learn finish (BEA-541: seal is sync, artifacts are async)
      expect(r!.closed).toBe(true);
      expect(dayCloses.find((c) => c.day === past)).toBeTruthy();
      expect(mentorCalls.some((m) => m.day === past && m.force)).toBe(true); // mentor re-ran for that day
      expect(mindCalls).toContain(past); // The Lab learns from the day once it's closed (BEA-458)
      expect(rolledCalls.some((c) => c.fromDay === past && c.toDay === today)).toBe(true);
      expect(tasks.find((t) => t.id === 'a').day).toBe(today); // leftover rolled forward
      expect(tasks.find((t) => t.id === 'b').day).toBe(past); // finished task stays on its real day
      expect(await svc.isClosed(past)).toBe(true);
    });

    it('closing TODAY with leftover open tasks rolls them to TOMORROW (not stranded on a sealed day)', async () => {
      const { svc, tasks } = makeService({ llmText: '{"story":"Today, closed early.","moodScore":60}' });
      const today = istToday();
      const tomorrow = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
      tasks.push({ id: 'tt', day: today, status: 'open', title: 'spillover' });
      const r = await svc.closeDay(today, false);
      expect(r!.rolled).toBe(1);
      expect(tasks.find((t) => t.id === 'tt').day).toBe(tomorrow);
    });

    it('activity() reports provisional for an un-sealed written day and final once closed', async () => {
      const { svc, dayStories } = makeService({ llmText: '{"story":"x","moodScore":50}' });
      const today = istToday();
      dayStories.push({ day: today, text: 'auto draft', moodScore: 42, createdAt: new Date(), updatedAt: new Date() });
      const a1 = await svc.activity(today);
      expect(a1.provisional).toBe(true);
      expect(a1.closed).toBe(false);
      await svc.closeDay(today, false);
      const a2 = await svc.activity(today);
      expect(a2.closed).toBe(true);
      expect(a2.provisional).toBe(false);
    });

    it('openDays lists un-closed past days with content; lifecycleTick auto-seals only days past the grace window', async () => {
      const { svc, tasks, dayCloses } = makeService({ llmText: '{"story":"sealed.","moodScore":55}' });
      const today = istToday();
      const add = (n: number) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
      tasks.push({ id: 'y', day: add(-1), status: 'open', title: 'yesterday' }); // within grace
      tasks.push({ id: 'o', day: add(-3), status: 'open', title: 'old' }); // past grace (>=2 days old)

      const open = await svc.openDays();
      expect(open.days.map((d: any) => d.day).sort()).toEqual([add(-3), add(-1)].sort());

      await svc.lifecycleTick();
      // only the old day auto-seals; yesterday is still within the 48h window
      expect(dayCloses.map((c: any) => c.day)).toEqual([add(-3)]);
      expect(dayCloses[0].auto).toBe(true);
    });
  });

  it('keeps one story per day — re-submitting updates in place', async () => {
    const { svc, stories } = makeService();
    await svc.submitStory('rough start to the day', 'app', '😐 Okay');
    const second = await svc.submitStory('actually it turned out great', 'app', '🤩 Great');
    expect(stories).toHaveLength(1);
    expect(second!.text).toContain('turned out great');
    expect(second!.mood).toBe('🤩 Great');
  });

  it('indexes the told story into memory stamped "activity" (Ask-your-life recall)', async () => {
    const { svc, enqueued } = makeService();
    await svc.submitStory('cracked the pricing section today', 'app', '🙂 Good');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].text).toContain('cracked the pricing');
    expect(enqueued[0].o.tags).toEqual(['activity', 'story']);
  });

  it('saves a story for a past day (the morning-after catch-up) but never for the future', async () => {
    const { svc, stories } = makeService();
    const past = await svc.submitStory('told the next morning on the commute', 'app', undefined, '2026-06-01');
    expect(past!.day).toBe('2026-06-01');
    const future = await svc.submitStory('time travel', 'app', undefined, '2099-01-01');
    expect(future!.day).not.toBe('2099-01-01'); // clamped to today
    expect(stories.find((s) => s.day === '2026-06-01')).toBeTruthy();
  });

  it('rewrites an already-written Story of the Day when the user narrates that day later', async () => {
    const { svc, dayStories } = makeService({ llmText: '{"story":"Rewritten around his own words.","mood":"reflective","moodScore":70}' });
    dayStories.push({ id: 'ds-old', day: '2026-06-01', text: 'Written without his story.', createdAt: new Date(0), updatedAt: new Date(0) });
    const out = await svc.submitStory('what really happened that day', 'app', undefined, '2026-06-01');
    expect(out!.rewriting).toBe(true);
    await new Promise((r) => setTimeout(r, 0)); // let the background rewrite finish
    expect(dayStories[0].text).toContain('Rewritten');
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

  it('reports a follow-through trend: this week vs the week before', async () => {
    const { svc, tasks } = makeService();
    const today = istToday();
    const ago = (n: number) => {
      const d = new Date(today + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().slice(0, 10);
    };
    // this week: 2 of 2 done (100%) · last week: 1 of 2 done (50%)
    tasks.push({ id: 'w1', day: ago(1), status: 'done' }, { id: 'w2', day: ago(2), status: 'done' });
    tasks.push({ id: 'p1', day: ago(8), status: 'done' }, { id: 'p2', day: ago(9), status: 'open' });
    const dash = await svc.dashboard(30);
    expect(dash.followTrend.week).toBe(100);
    expect(dash.followTrend.prevWeek).toBe(50);
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

  it('generates a day summary but does NOT index it to memory (the Story of the Day covers it) (BEA-551)', async () => {
    const { svc, summaries, enqueued } = makeService({ llmText: 'You finished the proposal and felt good.' });
    const out = await svc.generateSummary('2026-06-07');
    expect(out.text).toContain('proposal');
    expect(summaries).toHaveLength(1);
    expect(enqueued).toHaveLength(0); // day summaries are no longer redundant noise in the brain
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
    // stored to memory (RAG + SuperMemory) stamped "activity" (+ "story") so the sync never re-imports it
    expect(enqueued[0].o.tags).toEqual(['activity', 'story']);
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

  it('weights follow-through by part-done progress (BEA-761)', async () => {
    const { svc, tasks } = makeService();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    tasks.push({ day: today, status: 'done' }); // 100
    tasks.push({ day: today, status: 'open', progress: 60 }); // counts as 60, not 0
    tasks.push({ day: today, status: 'open', progress: 0 }); // 0
    const d = await svc.dashboard(30);
    expect(d.totals.tasksTotal).toBe(3);
    expect(d.totals.tasksDone).toBe(1); // still one FINISHED
    expect(d.totals.followThrough).toBe(53); // (100+60+0)/3 = 53, not 33
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

  describe('morning auto-wrap-up (BEA-467)', () => {
    it('wraps yesterday up when its story is in — closes it + triggers the Lab', async () => {
      const { svc, stories, dayCloses, mentorCalls, mindCalls } = makeService({ llmText: '{"story":"A wrapped day.","mood":"settled","moodScore":70}' });
      stories.push({ id: 's1', day: '2026-06-09', rawText: 'Solid day.', createdAt: new Date(), updatedAt: new Date() });
      const r = await svc.wrapYesterday('2026-06-10');
      await new Promise((res) => setImmediate(res)); // background artifacts/learn finish (BEA-541)
      expect(r).toEqual({ wrapped: true, reminded: false });
      expect(dayCloses.find((c) => c.day === '2026-06-09')).toBeTruthy();
      expect(mentorCalls.some((m) => m.day === '2026-06-09')).toBe(true);
      expect(mindCalls).toContain('2026-06-09'); // the Lab learns from the wrapped day
    });

    it('flags a single Telegram reminder when the story is NOT in', async () => {
      const { svc, dayCloses, settings } = makeService();
      const r = await svc.wrapYesterday('2026-06-10');
      expect(r).toEqual({ wrapped: false, reminded: true });
      expect(settings['telegram.pushStoryReminder']).toBe('2026-06-09');
      expect(dayCloses.length).toBe(0); // nothing closed
    });

    it('does nothing if yesterday is already closed', async () => {
      const { svc, stories, dayCloses, settings } = makeService();
      stories.push({ id: 's2', day: '2026-06-09', rawText: 'x', createdAt: new Date(), updatedAt: new Date() });
      dayCloses.push({ day: '2026-06-09', auto: false });
      const r = await svc.wrapYesterday('2026-06-10');
      expect(r).toEqual({ wrapped: false, reminded: false });
      expect(settings['telegram.pushStoryReminder']).toBeUndefined();
    });
  });

  describe('tell-the-story wraps the day immediately (BEA-469)', () => {
    const today = istToday();
    const y = (() => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();

    it('submitStory flags wrapped=true for a past day, false for today', async () => {
      const a = makeService({ llmText: '{"story":"x","moodScore":60}' });
      const ry = await a.svc.submitStory('Yesterday was good.', 'app', 'good', y);
      expect((ry as any).wrapped).toBe(true);

      const b = makeService({ llmText: '{"story":"x"}' });
      const rt = await b.svc.submitStory('Today is fine.', 'app', 'ok', today);
      expect((rt as any).wrapped).toBe(false);
      expect(b.dayCloses.length).toBe(0); // today is never sealed early
    });

    it('wrapDayNow closes the day and triggers Mentor + Lab', async () => {
      const { svc, dayCloses, mentorCalls, mindCalls } = makeService({ llmText: '{"story":"x","moodScore":60}' });
      expect(await svc.wrapDayNow(y)).toBe(true);
      await new Promise((res) => setImmediate(res)); // background artifacts/learn finish (BEA-541)
      expect(dayCloses.find((c) => c.day === y)).toBeTruthy();
      expect(mentorCalls.some((m) => m.day === y)).toBe(true);
      expect(mindCalls).toContain(y);
    });

    it('wrapDayNow is a no-op if the day is already closed', async () => {
      const { svc, dayCloses } = makeService();
      dayCloses.push({ day: y, auto: false });
      expect(await svc.wrapDayNow(y)).toBe(false);
    });
  });
});
