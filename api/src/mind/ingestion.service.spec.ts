import { MindIngestionService } from './ingestion.service';

function make(data: { tasks?: any[]; ideas?: any[]; stories?: any[]; summaries?: any[] }) {
  const tasks = data.tasks || [];
  const ideas = data.ideas || [];
  const stories = data.stories || [];
  const summaries = data.summaries || [];
  const prisma: any = {
    task: {
      findMany: async ({ where = {} }: any) => {
        let r = tasks;
        if (where.day !== undefined) r = r.filter((t) => t.day === where.day);
        if (where.status !== undefined) r = r.filter((t) => t.status === where.status);
        if (where.rolloverCount?.gt !== undefined) r = r.filter((t) => (t.rolloverCount ?? 0) > where.rolloverCount.gt);
        if (where.createdAt) r = r.filter((t) => t.createdAt >= where.createdAt.gte && t.createdAt < where.createdAt.lt);
        return r;
      },
    },
    idea: { findMany: async ({ where }: any) => ideas.filter((i) => i.createdAt >= where.createdAt.gte && i.createdAt < where.createdAt.lt) },
    story: { findFirst: async ({ where }: any) => stories.find((s) => s.day === where.day) || null },
    daySummary: { findUnique: async ({ where }: any) => summaries.find((s) => s.day === where.day) || null },
  };
  return new MindIngestionService(prisma);
}

const D = '2026-06-20';
const TODAY = '2026-06-22'; // D is in the past

describe('MindIngestionService.gatherDaySignals (BEA-446)', () => {
  it('detects done, skipped, and chronically-postponed tasks (action AND inaction)', async () => {
    const svc = make({
      tasks: [
        { id: 'a', title: 'Ship the quote', day: D, status: 'done', rolloverCount: 0, createdAt: new Date(D + 'T09:00:00') },
        { id: 'b', title: 'Call the bank', day: D, status: 'open', rolloverCount: 0, createdAt: new Date(D + 'T09:00:00') }, // skipped (past day, open)
        { id: 'c', title: 'Read vendor contract', day: '2026-06-22', status: 'open', rolloverCount: 4, createdAt: new Date('2026-06-10T09:00:00') }, // postponed 4x
      ],
    });
    const s = await svc.gatherDaySignals(D, TODAY);
    expect(s.tasks.done.map((t) => t.id)).toEqual(['a']);
    expect(s.tasks.skipped.map((t) => t.id)).toEqual(['b']);
    expect(s.tasks.postponed.map((t) => t.id)).toEqual(['c']);
    expect(s.tasks.postponed[0].rolloverCount).toBe(4);
    expect(s.tasks.counts).toMatchObject({ done: 1, skipped: 1, postponed: 1 });
    expect(s.hasSignal).toBe(true);
  });

  it('a future/today planned-open task is NOT counted as skipped', async () => {
    const svc = make({ tasks: [{ id: 'x', title: 'Today task', day: TODAY, status: 'open', rolloverCount: 0, createdAt: new Date(TODAY + 'T09:00:00') }] });
    const s = await svc.gatherDaySignals(TODAY, TODAY);
    expect(s.tasks.skipped).toHaveLength(0);
  });

  it('parses the story mood + worked breakdown (the feelings layer)', async () => {
    const svc = make({
      stories: [{ day: D, rawText: 'Long day, the pricing fight drained me.', mood: 'tired', workedMinutes: 480, workedBreakdown: JSON.stringify([{ category: 'Beakn', minutes: 300 }]), createdAt: new Date(D + 'T22:00:00') }],
    });
    const s = await svc.gatherDaySignals(D, TODAY);
    expect(s.story?.mood).toBe('tired');
    expect(s.story?.rawText).toContain('drained me');
    expect(s.story?.workedBreakdown).toEqual([{ category: 'Beakn', minutes: 300 }]);
  });

  it('reports no signal when the day is empty', async () => {
    const svc = make({});
    const s = await svc.gatherDaySignals(D, TODAY);
    expect(s.hasSignal).toBe(false);
    expect(s.tasks.done).toHaveLength(0);
  });
});
