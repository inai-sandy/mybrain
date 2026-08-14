import { buildPickList, rowTitle, taskIdFromRow, TASK_ROW } from './pick-list';

/**
 * BEA-1302 — "which one?" becomes something you tap.
 *
 * BEA-1294 made an ambiguous "done" safe: nothing claimed, and the person sent a numbered list with
 * a link. Safe, but it asks them to type a number or open a browser — and a message someone has to
 * interpret is a message that goes wrong, which is the thread running through this whole run.
 *
 * Now a tap carries its own id, so the same moment can be one tap. The rule that matters most is
 * the one that decides when a list is NOT good enough: two rows that read the same are not a
 * question, they are a coin toss, and the text version has room to say more.
 */

const three = [
  { id: 't1', title: 'Confirm the payment amount needed to process' },
  { id: 't2', title: 'Report the current status of the Varisters project' },
  { id: 't3', title: 'Place PCBs for the Elleys order' },
];

describe('building the list (BEA-1302)', () => {
  it('one row per job, each carrying that job\'s own id', () => {
    const list = buildPickList(three, { name: 'Deepthi' })!;
    expect(list.rows.map((r) => r.id)).toEqual(['task:t1', 'task:t2', 'task:t3']);
    expect(list.body).toContain('Deepthi');
    expect(list.body).toMatch(/which one/i);
  });

  it('shortens a long title but keeps the full one where they can read it', () => {
    const list = buildPickList(three)!;
    expect(list.rows[0].title.length).toBeLessThanOrEqual(24);
    expect(list.rows[0].description).toBe('Confirm the payment amount needed to process');
  });

  it('does not add a description when the title already fits', () => {
    const list = buildPickList([{ id: 'a', title: 'Send the report' }, { id: 'b', title: 'Call the vendor' }])!;
    expect(list.rows[0].description).toBeUndefined();
  });

  it('refuses when two rows would READ the same — a coin toss is not a question', () => {
    // Real titles from the owner's data: both start "Keep …", and shortened to 24 characters they
    // could become indistinguishable. Better to send the text version, which has room to say more.
    const same = [
      { id: 'a', title: 'Keep finished tested stock at 250 units and untested at 100' },
      { id: 'b', title: 'Keep finished tested stock at 250 units for the Beacon order' },
    ];
    expect(buildPickList(same)).toBeNull();
  });

  it('says nothing to choose between when there is only one job', () => {
    expect(buildPickList([{ id: 'a', title: 'The only one' }])).toBeNull();
    expect(buildPickList([])).toBeNull();
  });

  it('drops rows with no title or id rather than offering a blank choice', () => {
    expect(buildPickList([{ id: 'a', title: '  ' }, { id: 'b', title: 'Real' }])).toBeNull(); // only one left
  });

  it('offers ten and SAYS there are more — never a silent truncation', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, title: `Job number ${i}` }));
    const list = buildPickList(many, { link: 'https://mybrain.1site.ai/t/x' })!;
    expect(list.rows).toHaveLength(10);
    expect(list.note).toContain('10 of 14');
    expect(list.note).toContain('https://mybrain.1site.ai/t/x');
  });

  it('carries the "there are more" line in the BODY, so the link is not cut off', () => {
    // It used to ride in the footer, which WhatsApp caps at 60 characters and truncates silently —
    // so the link, the one actionable part, arrived broken. The note existed precisely so nothing
    // was dropped quietly. (review finding)
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `t${i}`, title: `Job number ${i}` }));
    const link = 'https://mybrain.1site.ai/t/deepthi-a6r8';
    const list = buildPickList(many, { name: 'Deepthi', link })!;
    expect(list.body).toMatch(/which one/i);
    expect(list.body).toContain(link); // survives whole, in a field with room for it
    expect(list.note!.length).toBeGreaterThan(60); // the very thing a footer would have mangled
  });

  it('says there are more even without a link to point at', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, title: `Job number ${i}` }));
    expect(buildPickList(many)!.note).toContain('10 of 12');
  });

  it('adds no note when everything fitted', () => {
    expect(buildPickList(three)!.note).toBeUndefined();
  });
});

describe('shortening a title (BEA-1302)', () => {
  it('leaves a short one alone', () => {
    expect(rowTitle('Send the report')).toBe('Send the report');
  });

  it('cuts at a word boundary when there is one worth using', () => {
    expect(rowTitle('Confirm the payment amount needed')).toBe('Confirm the payment…');
  });

  it('never exceeds the limit, however the words fall', () => {
    for (const t of ['x'.repeat(80), 'a b c d e f g h i j k l m n o p', 'Supercalifragilisticexpialidocious extra']) {
      expect(rowTitle(t).length).toBeLessThanOrEqual(24);
    }
  });

  it('collapses whitespace so a wrapped title does not waste its allowance', () => {
    expect(rowTitle('Send   the\n\nreport')).toBe('Send the report');
  });
});

describe('reading a tapped row (BEA-1302)', () => {
  it('gives back the task id', () => {
    expect(taskIdFromRow(`${TASK_ROW}abc123`)).toBe('abc123');
  });

  it('ignores anything that is not one of our rows', () => {
    // A Done button carries its own payload, and another app's list could carry anything at all.
    expect(taskIdFromRow('done')).toBeNull();
    expect(taskIdFromRow('')).toBeNull();
    expect(taskIdFromRow(null)).toBeNull();
    expect(taskIdFromRow(TASK_ROW)).toBeNull(); // the prefix with nothing behind it
  });
});

// ---- through the agent: the list going out, and a picked row coming back ----
function agent(over: { tasks?: any[]; reminders?: any[]; lastIn?: any; listResult?: any; noSendList?: boolean; claimResult?: any } = {}) {
  const contact = { id: 'c1', name: 'Deepthi', whatsappNumber: '919812345678' };
  const reminders = over.reminders ?? [
    { id: 'r1', status: 'active', subject: 'the payment', taskId: 't1' },
    { id: 'r2', status: 'active', subject: 'the Varisters status', taskId: 't2' },
  ];
  const tasks = over.tasks ?? [
    { id: 't1', title: 'Confirm the payment amount needed to process', kind: 'assignment', status: 'open', ownerContactId: 'c1', scheduleDays: null },
    { id: 't2', title: 'Report the current status of the Varisters project', kind: 'assignment', status: 'open', ownerContactId: 'c1', scheduleDays: null },
  ];
  const state: any = { texts: [], lists: [], out: [], claims: [], received: [] };
  const lastIn = over.lastIn ?? { direction: 'in', body: 'done sir', createdAt: new Date() };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: { findMany: async () => reminders, update: async () => undefined, updateMany: async () => undefined },
    reminderMessage: { findMany: async () => [lastIn], create: async ({ data }: any) => state.out.push(data) },
    reminderSend: { findMany: async () => [] },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    task: {
      findUnique: async ({ where }: any) => tasks.find((t: any) => t.id === where.id) || null,
      findMany: async ({ where }: any) => (where?.kind === 'recurring' ? [] : tasks),
    },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = {
    isConfigured: () => true,
    sendText: async (to: string, body: string) => { state.texts.push({ to, body }); return { wamid: 'w1' }; },
    ...(over.noSendList ? {} : { sendList: async (to: string, msg: any) => { state.lists.push({ to, msg }); return over.listResult ?? { wamid: 'wl1', status: 'sent' }; } }),
  };
  const { ReminderAgentService } = require('./reminder-agent.service');
  const svc = new ReminderAgentService(
    prisma, postbox,
    { voiceComplete: async () => '{"send":true,"reply":"Thanks!","needsSandeep":false,"done":[]}', shareLinkFor: async () => 'https://mybrain.1site.ai/t/deepthi-a6r8' } as any,
    { claim: async () => null, isPending: async () => false } as any,
    { today: () => '2026-08-14', markReceived: async (id: string) => { state.received.push(id); }, markNotReceived: async () => false, isReceived: async () => false, restDays: async () => ['Sun'] } as any,
    { recordPromise: async () => ({ ok: true }) } as any,
    { get: async () => '' } as any,
    { record: async () => null } as any,
    { recordClaim: async (i: any) => { state.claims.push(i); return over.claimResult ?? { claimed: true, task: { title: 'Confirm the payment amount needed to process' } }; } } as any,
  );
  return { svc, state };
}

describe('an ambiguous done gets a list, not a typing exercise (BEA-1302)', () => {
  it('sends the list, and claims nothing', async () => {
    const { svc, state } = agent();
    await svc.onContactReply('c1');
    expect(state.lists).toHaveLength(1);
    expect(state.lists[0].msg.rows.map((r: any) => r.id)).toEqual(['task:t1', 'task:t2']);
    expect(state.claims).toHaveLength(0);
  });

  it('records what she saw, so the thread is followable later', async () => {
    const { svc, state } = agent();
    await svc.onContactReply('c1');
    const stored = state.out.find((m: any) => m.direction === 'out');
    expect(stored.body).toMatch(/which one/i);
    expect(stored.body).toContain('Confirm the payment');
  });

  it('falls back to the numbered text when the list cannot be SENT', async () => {
    // The window shut, or Postbox refused. A silent failure here means she is never asked at all,
    // so this is proven rather than assumed.
    const { svc, state } = agent({ listResult: { wamid: null, status: 'failed', error: 'window closed' } });
    await svc.onContactReply('c1');
    expect(state.texts).toHaveLength(1);
    expect(state.texts[0].body).toMatch(/which one/i);
    expect(state.texts[0].body).toContain('1.');
  });

  it('falls back when the app cannot send lists at all', async () => {
    const { svc, state } = agent({ noSendList: true });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/which one/i);
  });

  it('falls back when two rows would read the same', async () => {
    const { svc, state } = agent({
      tasks: [
        { id: 't1', title: 'Keep finished tested stock at 250 units and untested at 100', kind: 'assignment', status: 'open', ownerContactId: 'c1' },
        { id: 't2', title: 'Keep finished tested stock at 250 units for the Beacon order', kind: 'assignment', status: 'open', ownerContactId: 'c1' },
      ],
    });
    await svc.onContactReply('c1');
    expect(state.lists).toHaveLength(0);
    expect(state.texts[0].body).toMatch(/which one/i);
  });
});

describe('picking a row settles it exactly (BEA-1302)', () => {
  const picked = (id: string) => ({ direction: 'in', body: 'Confirm the payment', buttonId: `task:${id}`, replyToWamid: 'wamid.LIST', createdAt: new Date() });

  it('claims that job, names it back, and asks no model', async () => {
    const { svc, state } = agent({ lastIn: picked('t1') });
    await svc.onContactReply('c1');
    expect(state.claims).toEqual([expect.objectContaining({ taskId: 't1' })]);
    expect(state.texts[0].body).toContain('Confirm the payment amount needed to process');
    expect(state.lists).toHaveLength(0); // no second question
  });

  it('a picked DAILY report settles today only', async () => {
    const { svc, state } = agent({
      lastIn: picked('t1'),
      tasks: [{ id: 't1', title: 'Send the daily production update', kind: 'recurring', status: 'open', ownerContactId: 'c1', scheduleDays: null }],
    });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
    expect(state.received).toEqual(['t1']);
    expect(state.texts[0].body).toMatch(/ask again/i);
  });

  it('a row for work already finished changes nothing', async () => {
    const { svc, state } = agent({
      lastIn: picked('t1'),
      tasks: [{ id: 't1', title: 'Old job', kind: 'assignment', status: 'done', ownerContactId: 'c1' }],
    });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
    expect(state.texts[0].body).toMatch(/already closed/i);
  });

  it('a row pointing at SOMEONE ELSE\'S work is refused, and she is TOLD', async () => {
    // Asserting only that nothing was claimed left the person with a generic conversational reply
    // and no idea their choice had not landed. (review finding)
    const { svc, state } = agent({
      lastIn: picked('t1'),
      tasks: [{ id: 't1', title: 'Not hers', kind: 'assignment', status: 'open', ownerContactId: 'c-other' }],
    });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
    expect(state.texts[0].body).toMatch(/not on your list any more/i);
  });

  it('an UNOWNED task is refused too — null is not a match', async () => {
    // A task unassigned after the list went out would otherwise sail through the guard written to
    // stop exactly that. (review finding)
    const { svc, state } = agent({
      lastIn: picked('t1'),
      tasks: [{ id: 't1', title: 'Nobody owns this', kind: 'assignment', status: 'open', ownerContactId: null }],
    });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
    expect(state.texts[0].body).toMatch(/not on your list any more/i);
  });

  it('a row for a task that no longer exists says so rather than going quiet', async () => {
    const { svc, state } = agent({ lastIn: picked('gone'), tasks: [] });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/not on your list any more/i);
  });
});
