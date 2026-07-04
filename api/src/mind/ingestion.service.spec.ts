import { MindIngestionService } from './ingestion.service';

function make(data: { tasks?: any[]; ideas?: any[]; stories?: any[]; summaries?: any[]; emails?: any[]; meetings?: any[] }) {
  const tasks = data.tasks || [];
  const ideas = data.ideas || [];
  const stories = data.stories || [];
  const summaries = data.summaries || [];
  const emails = data.emails || [];
  const meetings = data.meetings || [];
  const prisma: any = {
    emailMemory: { findMany: async ({ where }: any) => emails.filter((e) => e.day === where.day) },
    meeting: { findMany: async ({ where }: any) => meetings.filter((m) => m.createdAt >= where.createdAt.gte && m.createdAt < where.createdAt.lt) },
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

  it('uses the pre-rollover skipped snapshot when close provides it (BEA-808)', async () => {
    // the day's open tasks were already rolled forward, so the day query finds only the done one
    const svc = make({ tasks: [{ id: 'a', title: 'Ship the quote', day: D, status: 'done', rolloverCount: 0, createdAt: new Date(D + 'T09:00:00') }] });
    const snapshot = [{ id: 'b', title: 'Call the bank', day: D, status: 'open', rolloverCount: 0 }]; // captured before rollover
    const s = await svc.gatherDaySignals(D, TODAY, snapshot);
    expect(s.tasks.skipped.map((t) => t.id)).toEqual(['b']); // skipped came from the snapshot, not the (emptied) day query
    expect(s.tasks.done.map((t) => t.id)).toEqual(['a']);
  });

  it('a future/today planned-open task is NOT counted as skipped', async () => {
    const svc = make({ tasks: [{ id: 'x', title: 'Today task', day: TODAY, status: 'open', rolloverCount: 0, createdAt: new Date(TODAY + 'T09:00:00') }] });
    const s = await svc.gatherDaySignals(TODAY, TODAY);
    expect(s.tasks.skipped).toHaveLength(0);
  });

  it('captures created items by IST day, not UTC (BEA-811)', async () => {
    // created 2026-07-02 20:00 UTC = 2026-07-03 01:30 IST → belongs to July 3 (IST), not July 2
    const t = { id: 'z', title: 'late-night task', day: '2026-07-03', status: 'open', rolloverCount: 0, createdAt: new Date('2026-07-02T20:00:00Z') };
    const svc = make({ tasks: [t] });
    const jul2 = await svc.gatherDaySignals('2026-07-02', '2026-07-05');
    expect(jul2.tasks.created.find((x) => x.id === 'z')).toBeUndefined(); // NOT attributed to July 2
    const jul3 = await svc.gatherDaySignals('2026-07-03', '2026-07-05');
    expect(jul3.tasks.created.find((x) => x.id === 'z')).toBeTruthy();     // correctly on July 3 IST
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

  it('includes that day\'s important emails + meetings (BEA-453)', async () => {
    const svc = make({
      emails: [{ day: D, fromAddr: 'vendor@acme.com', subject: 'June invoice', snippet: 'attached' }],
      meetings: [{ createdAt: new Date(D + 'T15:00:00'), title: 'Sales sync', summary: 'discussed pipeline', decisions: JSON.stringify(['ship Friday']) }],
    });
    const s = await svc.gatherDaySignals(D, TODAY);
    expect(s.emails[0]).toMatchObject({ from: 'vendor@acme.com', subject: 'June invoice' });
    expect(s.meetings[0]).toMatchObject({ title: 'Sales sync', decisions: ['ship Friday'] });
    expect(s.hasSignal).toBe(true);
  });
});
