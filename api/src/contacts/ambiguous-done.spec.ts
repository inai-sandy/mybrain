import { ambiguousDoneReply } from './claim-reply';

/**
 * BEA-1294 — "done sir" when three things are open.
 *
 * The owner: *"I hope you are not getting which task is done. When they say it's done, you have to
 * reply to them with which task they have finished, or else you have to provide them the link from
 * where they can update the task that they have finished."* He chose both.
 *
 * Live at the time of writing: Deepthi has 3 open items, Radha 2, Jayanth 2. Guessing here is not a
 * symmetric mistake — pausing the wrong chase means work everybody now believes is finished quietly
 * stops being asked about, and nobody finds out until it is late.
 */

describe('the "which one?" message (BEA-1294)', () => {
  const three = [
    { n: 1, label: 'Confirm the payment amount needed to process' },
    { n: 2, label: 'Report the current status of the Varisters project' },
    { n: 3, label: 'Place PCBs for the Elleys order' },
  ];

  it('lists every open item AND hands over their link', () => {
    const out = ambiguousDoneReply(three, 'https://mybrain.1site.ai/t/deepthi-a6r8');
    expect(out).toContain('1. Confirm the payment amount needed to process');
    expect(out).toContain('2. Report the current status of the Varisters project');
    expect(out).toContain('3. Place PCBs for the Elleys order');
    expect(out).toContain('https://mybrain.1site.ai/t/deepthi-a6r8');
    expect(out).toMatch(/which one/i);
  });

  it('keeps the numbers the assistant was already using — never a second numbering', () => {
    // A separate numbering would be a fresh way to pick the wrong task. If they reply "5", it has
    // to mean the item shown as 5.
    const out = ambiguousDoneReply([{ n: 4, label: 'Fourth thing' }, { n: 5, label: 'Fifth thing' }], null);
    expect(out).toContain('4. Fourth thing');
    expect(out).toContain('5. Fifth thing');
    expect(out).not.toContain('1. Fourth thing');
  });

  it('still works with no link — asks for the number instead of pasting a dead one', () => {
    const out = ambiguousDoneReply(three, null);
    expect(out).toMatch(/reply with the number/i);
    expect(out).not.toContain('http');
  });

  it('says NOTHING when there is only one thing open — that is not ambiguous', () => {
    expect(ambiguousDoneReply([{ n: 1, label: 'The only thing' }], 'https://x.test/t/a')).toBe('');
    expect(ambiguousDoneReply([], 'https://x.test/t/a')).toBe('');
  });

  it('drops rows with nothing to show rather than printing a blank line', () => {
    const out = ambiguousDoneReply([{ n: 1, label: '' }, { n: 2, label: 'Real one' }, { n: 3, label: 'Other real one' }], null);
    expect(out).not.toMatch(/^1\. *$/m);
    expect(out).toContain('2. Real one');
  });
});

// ---- the agent behaves as promised ----
function agent(voice: string, over: { work?: any[]; reminders?: any[]; slug?: string | null; lastIn?: string } = {}) {
  const contact = { id: 'c1', name: 'Deepthi', whatsappNumber: '919812345678' };
  const reminders = over.reminders ?? [
    { id: 'r1', status: 'active', subject: 'the payment amount', taskId: 't1' },
    { id: 'r2', status: 'active', subject: 'the Varisters status', taskId: 't2' },
    { id: 'r3', status: 'active', subject: 'the Elleys PCBs', taskId: 't3' },
  ];
  const tasks = over.work ?? [
    { id: 't1', title: 'Confirm the payment amount needed to process', status: 'open', kind: 'assignment' },
    { id: 't2', title: 'Report the current status of the Varisters project', status: 'open', kind: 'assignment' },
    { id: 't3', title: 'Place PCBs for the Elleys order', status: 'open', kind: 'assignment' },
  ];
  const state: any = { texts: [] as any[], out: [] as any[], claims: [] as any[] };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: { findMany: async () => reminders, update: async () => undefined, updateMany: async () => undefined },
    reminderMessage: {
      findMany: async () => [{ direction: 'in', body: over.lastIn ?? 'done sir' }],
      create: async ({ data }: any) => state.out.push(data),
    },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    // findMany answers BOTH the "which of these are recurring" query and the title lookup.
    task: { findUnique: async () => null, findMany: async ({ where }: any) => (where?.kind === 'recurring' ? [] : tasks) },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = { isConfigured: () => true, sendText: async (to: string, body: string) => { state.texts.push({ to, body }); return { wamid: 'w1' }; } };
  const remindersSvc: any = {
    voiceComplete: async () => voice,
    shareLinkFor: async () => (over.slug === null ? null : `https://mybrain.1site.ai/t/${over.slug || 'deepthi-a6r8'}`),
  };
  const delegation: any = {
    recordClaim: async (i: any) => { state.claims.push(i); return { claimed: true, task: { title: 'something' } }; },
  };
  const { ReminderAgentService } = require('./reminder-agent.service');
  const svc = new ReminderAgentService(
    prisma,
    postbox,
    remindersSvc,
    { claim: async () => ({ id: 'cl1' }), isPending: async () => false } as any,
    { today: () => '2026-08-13', markReceived: async () => undefined, isReceived: async () => false, restDays: async () => ['Sun'] } as any,
    { recordPromise: async () => ({ ok: true }) } as any,
    { get: async () => '' } as any,
    { record: async () => null } as any,
    delegation,
  );
  return { svc, state };
}

describe('a bare "done" claims NOTHING when three things are open (BEA-1294)', () => {
  const VAGUE = '{"send":true,"reply":"Thanks Deepthi!","needsSandeep":false,"done":[]}';

  it('asks which one, listing all three and the link', async () => {
    const { svc, state } = agent(VAGUE);
    await svc.onContactReply('c1');
    expect(state.texts).toHaveLength(1);
    const body = state.texts[0].body;
    expect(body).toMatch(/which one/i);
    expect(body).toContain('Confirm the payment amount needed to process');
    expect(body).toContain('Place PCBs for the Elleys order');
    expect(body).toContain('/t/deepthi-a6r8');
  });

  it('records no claim and therefore pauses no chase', async () => {
    // The whole point: a guess would silence a chase for work that is still open.
    const { svc, state } = agent(VAGUE);
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
  });

  it('does NOT ask when the model DID identify the item — that is not ambiguous', async () => {
    const { svc, state } = agent('{"send":true,"reply":"Nice one!","needsSandeep":false,"done":[2]}');
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(1);
    expect(state.texts[0].body).not.toMatch(/which one/i);
  });

  it('does NOT ask when only one thing is open', async () => {
    const { svc, state } = agent(VAGUE, {
      reminders: [{ id: 'r1', status: 'active', subject: 'the payment amount', taskId: 't1' }],
      work: [{ id: 't1', title: 'Confirm the payment amount', status: 'open', kind: 'assignment' }],
    });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/which one/i);
  });

  it('does NOT ask when the message was never a completion in the first place', async () => {
    // "will do it tomorrow" is a promise, not a claim. Asking "which one do you mean?" there would
    // be the app not reading the message at all.
    const { svc, state } = agent(VAGUE, { lastIn: 'sir I will do it tomorrow morning' });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/which one/i);
  });

  it('does NOT ask when they are only reporting progress', async () => {
    const { svc, state } = agent(VAGUE, { lastIn: 'started working on it sir' });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/which one/i);
  });

  it('asks for the number when their page is switched off — never pastes a dead link', async () => {
    const { svc, state } = agent(VAGUE, { slug: null });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/which one/i);
    expect(state.texts[0].body).not.toContain('http');
  });
});

describe('the question never swallows something more important (BEA-1294)', () => {
  const VAGUE = '{"send":true,"reply":"Thanks Deepthi!","needsSandeep":false,"done":[]}';

  it('keeps the escalation when the same message ALSO needs Sandeep', async () => {
    // A message can be both — "the videos are done but the machine is down". Replacing the reply
    // would answer a real problem with "which one do you mean?" and nothing else, while the owner
    // gets pinged behind the scenes and the person hears nothing about it. (review finding)
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check with Sandeep and come back to you.","needsSandeep":true,"done":[]}');
    await svc.onContactReply('c1');
    const body = state.texts[state.texts.length - 1].body;
    expect(body).toContain("I'll check with Sandeep");
    expect(body).toMatch(/which one/i); // both survive
  });

  it('replaces the generic thanks when nothing else was at stake', async () => {
    const { svc, state } = agent('{"send":true,"reply":"Thanks Deepthi!","needsSandeep":false,"done":[]}');
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toContain('Thanks Deepthi!');
    expect(state.texts[0].body).toMatch(/^Which one/i);
  });

  it('does not fire on a long numbers-heavy report that happens to contain a done-word', async () => {
    // `readUpdate` is read WITH the report guard, same as every other place that makes a decision
    // on this signal. Without it, a real evening update gets interrupted with "which one?".
    // (review finding)
    const { svc, state } = agent(VAGUE, {
      lastIn: 'Good evening sir, today 240 units tested, 180 packed, 3rd floor line ran till 6pm, 12 pieces dispatched to Beacon, OT 4 hours for 6 people',
    });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/which one/i);
  });
});

describe('the daily-report nudge is not suppressed by this link (BEA-1294)', () => {
  it('the check looks for the DAILY link, not any link to their page', () => {
    // Both replies carry a `/t/<slug>` link. A bare '/t/' check let the "which one?" message
    // suppress the real "fill today's update here" nudge for the next several turns, so a daily
    // reporter could stop being pointed at their form without anyone noticing. (review finding)
    const src = require('fs').readFileSync(require('path').join(__dirname, 'reminder-agent.service.ts'), 'utf8');
    const line = src.split('\n').find((l: string) => l.includes('const linkAlreadySent'));
    expect(line).toContain('?tab=updates');
    expect(line).not.toMatch(/includes\('\/t\/'\)/);
  });
});
