import { MindStatsService } from './stats.service';

function makePrisma(data: { dayStories?: any[]; findings?: any[]; tasks?: any[] }) {
  const prisma: any = {
    dayStory: { findMany: async () => data.dayStories || [] },
    mindFinding: { findMany: async () => data.findings || [] },
    task: { findMany: async () => data.tasks || [] },
  };
  return new MindStatsService(prisma);
}

describe('MindStatsService (BEA-455)', () => {
  it('builds the mood series + day-of-week averages', async () => {
    const svc = makePrisma({
      dayStories: [
        { day: '2026-06-21', moodScore: 80 }, // Sunday
        { day: '2026-06-20', moodScore: 60 }, // Saturday
        { day: '2026-06-14', moodScore: 40 }, // Sunday
      ],
    });
    const s = await svc.stats();
    expect(s.moodSeries.map((m) => m.mood)).toEqual([40, 60, 80]); // oldest→newest
    const sun = s.dowMood.find((d) => d.dow === 0)!;
    expect(sun.avg).toBe(60); // (80 + 40) / 2
    expect(sun.n).toBe(2);
  });

  it('splits findings into energizers vs drainers with strength + sample size', async () => {
    const svc = makePrisma({
      findings: [
        { subject: 'gym', statement: 'Gym energizes you', valence: 'energizing', confidence: 0.6, evidenceCount: 4 },
        { subject: 'admin', statement: 'Admin drains you', valence: 'draining', confidence: 0.7, evidenceCount: 5 },
      ],
    });
    const s = await svc.stats();
    expect(s.energizers[0]).toMatchObject({ label: 'gym', strength: 60, n: 4 });
    expect(s.drainers[0]).toMatchObject({ label: 'admin', strength: 70, n: 5 });
  });

  it('builds the category avoidance map (deferred / done by category)', async () => {
    const svc = makePrisma({
      tasks: [
        { category: 'Admin', status: 'open', rolloverCount: 4 },
        { category: 'Admin', status: 'open', rolloverCount: 2 },
        { category: 'Admin', status: 'done', rolloverCount: 0 },
        { category: 'Health', status: 'done', rolloverCount: 0 },
        { category: 'Health', status: 'done', rolloverCount: 0 },
      ],
    });
    const s = await svc.stats();
    const admin = s.categories.find((c) => c.category === 'Admin')!;
    expect(admin).toMatchObject({ done: 1, deferred: 2, total: 3 });
    expect(admin.avoidance).toBe(67); // 2/3
  });
});
