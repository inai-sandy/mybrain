import { HomeService } from './home.service';

/** What a paused flow run looks like in the database: a gate, or an ordinary "Ask me". */
function waitingFlow(kind: 'gate' | 'ask') {
  const results = kind === 'gate'
    ? { n1: { status: 'waiting', kind: 'tool', label: 'Tidy up', gate: { headline: 'Delete a repository on GitHub — inai-sandy/old', args: {} } } }
    : { n1: { status: 'waiting', kind: 'ask_user', label: 'Ask me' } };
  return {
    id: 'fr1',
    waitNodeId: 'n1',
    waitQuestion: kind === 'gate'
      ? 'Delete a repository on GitHub — inai-sandy/old? This cannot be undone.\n\nIt will run with: owner = inai-sandy'
      : 'Which angle should I take?',
    results: JSON.stringify(results),
    startedAt: new Date(),
  };
}

function makeSvc(over: { flowWaiting?: any[] } = {}) {
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
    flowRun: { count: async () => 0, findMany: async () => over.flowWaiting || [] },
    reminder: { findMany: async () => [{ contact: { name: 'Srikar' }, subject: 'the BOM' }] },
    reminderSend: { count: async () => 2 },
    task: { findMany: async () => [] },
    mentorDay: { findFirst: async () => ({ day: '2026-07-06', guidance: 'Do more Saturdays like this one.' }) },
    // Work someone says is finished, waiting on the owner (BEA-1025). None in this fixture.
    taskClaim: { findMany: async () => [] },
    daySummary: { findUnique: async () => null },
  };
  const tasks: any = { today: async () => ({ tasks: [{ status: 'open', title: 'A' }], dumped: true, counts: { done: 5, total: 22 } }) };
  const daily: any = {
    today: async () => ({ storyDone: true }),
    dashboard: async () => ({ streak: 2, totals: { followThrough: 73 }, followTrend: { week: 73, prevWeek: 100 }, minutesSpent: 3400 }),
    activity: async () => ({ day: '2026-07-06', summary: { text: 'A good day.' }, stats: { minutesSpent: 192 } }),
    getPersonality: async () => ({ unlocked: true, summary: 'You focus well alone.', daysCovered: 10, minDays: 7 }),
  };
  return new HomeService(
    prisma,
    tasks,
    daily,
    { restDays: async () => ['Sun'] } as any,
    { brainCounts: async () => ({ total: 0, types: [] }) } as any,
  );
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

/**
 * BEA-1348 — a paused flow reaches the Home card at all (its rows are `waiting`, and this query
 * used to ask for `running`), and a gate says it is a gate.
 */
describe('HomeService — a flow waiting on you (BEA-1348)', () => {
  it('shows a gate as something to say yes or no to', async () => {
    const d = await makeSvc({ flowWaiting: [waitingFlow('gate')] }).summary();
    const flow = d.needsYou.find((n) => n.kind === 'flow')!;
    expect(flow).toBeTruthy();
    expect(flow.title).toBe('A flow needs your OK');
    expect(flow.action).toBe('Answer');
    expect(flow.sub).toContain('This cannot be undone');
    expect(flow.href).toBe('/flows/runs/fr1');
  });

  it('shows an ordinary question as a question', async () => {
    const d = await makeSvc({ flowWaiting: [waitingFlow('ask')] }).summary();
    const flow = d.needsYou.find((n) => n.kind === 'flow')!;
    expect(flow.title).toBe('A flow needs your input');
    expect(flow.action).toBe('Reply');
  });
});
