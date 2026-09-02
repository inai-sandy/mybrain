import { HomeService } from './home.service';
import { readLabel } from '../contacts/update-read';

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

/** What the review inbox holds — the SAME rows Tasks → Needs you draws. (BEA-1596) */
// Each row's label is what the real inbox writes: `readLabel(reads)`, the ONE map. (BEA-1597)
const INBOX_ROWS = [
  { id: 'u1', channel: 'whatsapp', text: 'Need 298usd for the Elleys PCB advance sir', reads: ['needs_you', 'money'], label: readLabel(['needs_you', 'money']), contact: { id: 'c1', name: 'Deepthi', whatsappNumber: '919000000000' }, canReply: true, closedAt: null, at: new Date('2026-08-31') },
  { id: 'u2', channel: 'system', text: 'No reply for 3 h — "sir the vendor is refusing"', reads: ['needs_you', 'no_reply'], label: readLabel(['needs_you', 'no_reply']), contact: { id: 'c2', name: 'Rakesh' }, canReply: false, closedAt: null, at: new Date('2026-09-02') },
  { id: 'u3', channel: 'whatsapp', text: 'closed already', reads: ['needs_you', 'blocked'], label: readLabel(['needs_you', 'blocked']), contact: { id: 'c3', name: 'Jayanth' }, closedAt: new Date('2026-09-01'), at: new Date('2026-08-18') },
  { id: 'claim:cl1', claimId: 'cl1', channel: 'whatsapp', text: 'sir it is done', label: 'says it is done', contact: { id: 'c4', name: 'Srikar' }, closedAt: null, at: new Date('2026-09-02') },
  // A message the inbox glued a pending claim onto — its id is the update's, but it IS the claim.
  { id: 'u5', claimId: 'cl2', channel: 'whatsapp', text: 'PCBs also sent sir', label: 'says it is done', contact: { id: 'c5', name: 'Radha' }, closedAt: null, at: new Date('2026-09-02') },
];

function makeSvc(over: { flowWaiting?: any[]; inbox?: any[] } = {}) {
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
  // The inbox stub applies the one rule that matters here: a closed row is not in the inbox.
  const updates: any = { inbox: async () => { const items = (over.inbox ?? INBOX_ROWS).filter((r) => !r.closedAt); return { items, count: items.length }; } };
  return new HomeService(
    prisma,
    tasks,
    daily,
    { restDays: async () => ['Sun'] } as any,
    { brainCounts: async () => ({ total: 0, types: [] }) } as any,
    updates,
  );
}

describe('HomeService — command center (BEA-897)', () => {
  it('aggregates NeedsYou across Emo, agents and the team inbox', async () => {
    const d = await makeSvc().summary();
    const kinds = d.needsYou.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(['emo', 'agent', 'team']));
    const emo = d.needsYou.find((n) => n.kind === 'emo')!;
    expect(emo.action).toBe('Answer');
    expect(emo.sub).toContain('Which region');
    expect(d.needsYou.find((n) => n.kind === 'team')!.title).toContain('Deepthi');
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

/**
 * BEA-1596 — the Dashboard's team rows ARE the review inbox. It used to read `Reminder.needsOwner`,
 * a flag nothing reliably cleared, so it showed four people while Tasks → Needs you showed none.
 */
describe('HomeService — Needs you reads the review inbox (BEA-1596)', () => {
  it('draws one team row per open inbox item, with the same text, pointing at the Needs you tab', async () => {
    const d = await makeSvc().summary();
    const team = d.needsYou.filter((n) => n.kind === 'team');
    expect(team.map((n) => n.title)).toEqual(['Deepthi: Need 298usd for the Elleys PCB advance sir', 'Rakesh: No reply for 3 h — "sir the vendor is refusing"']);
    expect(team.every((n) => n.href === '/tasks?tab=review' && n.action === 'Reply')).toBe(true);
    expect(team[0]).toMatchObject({ icon: '💬', sub: 'asked for money' });
    expect(team[1].icon).toBe('⏳'); // the watchdog's own row
  });

  /**
   * BEA-1597 — the reason line on the Dashboard IS the inbox item's `readLabel()` string. Both
   * surfaces read the one map; this is the lock that they cannot drift apart.
   */
  it('the reason line is the same readLabel() string the inbox item carries', async () => {
    const d = await makeSvc().summary();
    const team = d.needsYou.filter((n) => n.kind === 'team');
    expect(team.map((n) => n.sub)).toEqual([readLabel(['needs_you', 'money']), readLabel(['needs_you', 'no_reply'])]);
    expect(team.map((n) => n.sub)).toEqual(['asked for money', 'waiting on your reply']);
  });

  it('a team row carries the inbox item behind it, so the Dashboard can open the same reply sheet', async () => {
    const d = await makeSvc().summary();
    const team = d.needsYou.filter((n) => n.kind === 'team');
    expect(team[0].update).toEqual({ id: 'u1', text: 'Need 298usd for the Elleys PCB advance sir', label: 'asked for money', contact: { id: 'c1', name: 'Deepthi' }, canReply: true });
    expect(team[1].update).toMatchObject({ id: 'u2', canReply: false });
    expect(team[0].href).toBe('/tasks?tab=review'); // a plain tap on the text still goes to the tab
  });

  it('a closed update is absent, and a pure claim row is not listed twice', async () => {
    const d = await makeSvc().summary();
    expect(d.needsYou.some((n) => n.title.includes('Jayanth'))).toBe(false); // closed 1 Sept
    expect(d.needsYou.filter((n) => n.kind === 'team').some((n) => n.title.includes('Srikar'))).toBe(false); // already a `claim` row
    expect(d.needsYou.filter((n) => n.kind === 'team').some((n) => n.title.includes('Radha'))).toBe(false); // a message WITH a claim on it — same
  });

  it('the old reminder kind is gone — nothing reads Reminder.needsOwner', async () => {
    const d = await makeSvc().summary();
    expect(d.needsYou.some((n) => n.kind === 'reminder')).toBe(false);
    expect(d.needsYou.some((n) => n.title.includes('needs a reply'))).toBe(false);
  });

  it('ranks team rows right after claims, ahead of overdue tasks', async () => {
    const d = await makeSvc().summary();
    const order = d.needsYou.map((n) => n.kind);
    expect(order.indexOf('team')).toBeLessThan(order.indexOf('agent'));
  });

  it('an empty inbox draws nothing, and a missing inbox service cannot take Home down', async () => {
    expect((await makeSvc({ inbox: [] }).summary()).needsYou.some((n) => n.kind === 'team')).toBe(false);
    const bare = new HomeService(
      { item: { count: async () => 0, findMany: async () => [] }, idea: { count: async () => 0 }, skill: { count: async () => 0 }, note: { count: async () => 0 }, contact: { count: async () => 0 }, meeting: { count: async () => 0 }, emoCard: { count: async () => 0, findMany: async () => [] }, agentRun: { count: async () => 0, findMany: async () => [] }, flowRun: { count: async () => 0, findMany: async () => [] }, reminderSend: { count: async () => 0 }, task: { findMany: async () => [] }, mentorDay: { findFirst: async () => null }, taskClaim: { findMany: async () => [] }, daySummary: { findUnique: async () => null } } as any,
      { today: async () => ({ tasks: [], dumped: false, counts: {} }) } as any,
      { today: async () => ({}), dashboard: async () => ({ totals: {} }), activity: async () => ({}), getPersonality: async () => ({}) } as any,
      { restDays: async () => ['Sun'] } as any,
      { brainCounts: async () => ({ total: 0, types: [] }) } as any,
    );
    expect((await bare.summary()).needsYou).toEqual([]);
  });
});
