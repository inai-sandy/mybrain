import { HomeService } from './home.service';

function makeSvc() {
  const delta = (w: any) => !!w?.createdAt; // a "today-new" count query
  const prisma: any = {
    item: { count: async ({ where }: any) => (delta(where) ? 2 : where?.source === 'raindrop' ? 93 : 35), findMany: async () => [{ id: 'i1', title: 'Recent doc', source: 'app', createdAt: new Date() }] },
    idea: { count: async ({ where }: any = {}) => (delta(where) ? 0 : 5) },
    skill: { count: async ({ where }: any = {}) => (delta(where) ? 1 : 24) },
    note: { count: async ({ where }: any = {}) => (delta(where) ? 0 : 18) },
    contact: { count: async ({ where }: any = {}) => (delta(where) ? 0 : 31) },
    meeting: { count: async ({ where }: any = {}) => (delta(where) ? 0 : where?.status === 'transcribing' ? 0 : 7) },
    emoCard: {
      count: async ({ where }: any = {}) => (delta(where) ? 3 : where?.status === 'cooking' ? 2 : 12),
      findMany: async ({ where }: any) => (where?.status === 'needs_you' ? [{ lane: 'search', summary: 'CCTV market', needsQuestion: 'Which region?', createdAt: new Date() }] : []),
    },
    agentRun: {
      count: async ({ where }: any) => (where?.status === 'running' ? 1 : 0),
      findMany: async ({ where }: any) => (where?.status === 'awaiting_input' ? [{ id: 'a1', title: 'Research agent' }] : []),
    },
    flowRun: { count: async () => 0, findMany: async () => [] },
    reminder: { findMany: async () => [{ contact: { name: 'Srikar' }, subject: 'the BOM' }] },
    reminderSend: { count: async () => 2 },
    task: { findMany: async () => [] },
    mentorDay: { findFirst: async () => ({ day: '2026-07-06', guidance: 'Do more Saturdays like this one.' }) },
    daySummary: { findUnique: async () => null },
  };
  const tasks: any = { today: async () => ({ tasks: [{ status: 'open', title: 'A' }], dumped: true, counts: { done: 5, total: 22 } }) };
  const daily: any = {
    today: async () => ({ storyDone: true }),
    dashboard: async () => ({ streak: 2, totals: { followThrough: 73 }, followTrend: { week: 73, prevWeek: 100 }, minutesSpent: 3400 }),
    activity: async () => ({ day: '2026-07-06', summary: { text: 'A good day.' }, stats: { minutesSpent: 192 } }),
    getPersonality: async () => ({ unlocked: true, summary: 'You focus well alone.', daysCovered: 10, minDays: 7 }),
  };
  return new HomeService(prisma, tasks, daily);
}

describe('HomeService — command center (BEA-897)', () => {
  it('aggregates NeedsYou across Emo, agents and reminders', async () => {
    const d = await makeSvc().summary();
    const kinds = d.needsYou.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(['emo', 'agent', 'reminder']));
    const emo = d.needsYou.find((n) => n.kind === 'emo')!;
    expect(emo.action).toBe('Answer');
    expect(emo.sub).toContain('Which region');
    expect(d.needsYou.find((n) => n.kind === 'reminder')!.title).toContain('Srikar');
  });

  it('lists only non-zero cooking items, pluralised', async () => {
    const d = await makeSvc().summary();
    const labels = d.cooking.map((c) => c.label);
    expect(labels).toContain('1 agent run running'); // singular
    expect(labels).toContain('2 Emo cards cooking'); // plural
    expect(labels).toContain('2 reminders queued today');
    expect(labels.some((l) => l.includes('flow'))).toBe(false); // zero → hidden
    expect(labels.some((l) => l.includes('transcribing'))).toBe(false);
  });

  it('widens counts and includes today-new deltas + guidance', async () => {
    const d = await makeSvc().summary();
    expect(d.counts).toMatchObject({ documents: 35, bookmarks: 93, notes: 18, contacts: 31, meetings: 7, emoCards: 12 });
    expect(d.countsNew.emoCards).toBe(3);
    expect(d.countsNew.skills).toBe(1);
    expect(d.insights.guidance).toContain('Saturdays');
  });
});
