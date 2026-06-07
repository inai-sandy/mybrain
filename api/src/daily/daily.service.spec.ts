import { DailyService } from './daily.service';

function makeService() {
  const stories: any[] = [];
  const notes: any[] = [];
  let seq = 0;
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
  };
  return { svc: new DailyService(prisma), stories, notes };
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
});
