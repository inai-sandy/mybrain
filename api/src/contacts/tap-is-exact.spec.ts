import { readTap, isTap } from './tap';
import { resolveTap } from './tap-handler';

/**
 * BEA-1300 — a tap decides, not a model.
 *
 * "Is this piece of work finished?" is the most consequential question in the delegation loop, and
 * until now it went through a language model even when someone had pressed a button that could only
 * mean one thing. Deepthi taps **Done**; it arrives as the word "done"; the model reads her thread
 * and guesses which of her three jobs she meant. A wrong guess silences the chase for work that is
 * still open, and nobody finds out until it is late.
 *
 * The rule throughout: anything less than certain returns null and the words get read instead.
 * Guessing is what this exists to remove, so it must not reappear as a fallback.
 */

describe('reading a tap (BEA-1300)', () => {
  const tap = (body: string, buttonId = 'x') => readTap({ buttonId, body });

  it('reads the three buttons on the nudge', () => {
    expect(tap('Done')).toBe('done');
    expect(tap('Still working on it')).toBe('working');
    expect(tap("I'll reply here")).toBe('will-reply');
  });

  it('is not fooled by wording that CONTAINS "done" but means the opposite', () => {
    // "Not done yet" is the trap: a naive contains-check reads it as a completion and silences a
    // chase for work the person has just said is unfinished.
    expect(tap('Not done yet')).toBe('working');
    expect(tap('not done')).toBe('working');
  });

  it('ignores case, spacing and trailing punctuation', () => {
    expect(tap('  DONE! ')).toBe('done');
    expect(tap('still  working')).toBe('working');
  });

  it('a TYPED message is never a tap, however it is worded', () => {
    // The whole distinction: the same word carries far less certainty when it was typed inside a
    // sentence, and this is what tells the two apart.
    expect(readTap({ buttonId: null, body: 'done' })).toBeNull();
    expect(readTap({ body: 'Done' })).toBeNull();
    expect(isTap({ buttonId: null })).toBe(false);
    expect(isTap({ buttonId: 'done' })).toBe(true);
  });

  it('a button we do not recognise is NOT decisive — the words get read instead', () => {
    // The template was created in Meta's console, not by this code, and could be edited without
    // telling us. An unknown label must fall through, never be guessed at.
    expect(tap('Escalate to Sandeep')).toBeNull();
    expect(tap('')).toBeNull();
  });
});

// ---- resolving what the tap was about ----
function db(over: any = {}) {
  const sends = over.sends ?? [
    { reminder: { id: 'r1', taskId: 't1', status: 'active' } },
    { reminder: { id: 'r2', taskId: 't2', status: 'active' } },
  ];
  const tasks = over.tasks ?? [
    { id: 't1', title: 'Confirm the payment amount', kind: 'assignment', status: 'open' },
    { id: 't2', title: 'Place the PCBs', kind: 'assignment', status: 'open' },
  ];
  const seen: any = { sendWhere: null };
  return {
    seen,
    prisma: {
      reminderSend: { findMany: async ({ where }: any) => { seen.sendWhere = where; return sends; } },
      task: { findMany: async ({ where }: any) => tasks.filter((t: any) => where.id.in.includes(t.id)) },
    } as any,
  };
}

const TAP = { buttonId: 'done', body: 'Done', replyToWamid: 'wamid.OUT7' };

describe('resolving a tap to the exact work (BEA-1300)', () => {
  it('finds EVERY job the tapped nudge covered, not just the first', async () => {
    // One message can chase three things. Resolving to whichever chase happened to be first would
    // be a guess wearing a lookup's clothes.
    const { prisma, seen } = db();
    const res = await resolveTap(prisma, TAP);
    expect(res?.meaning).toBe('done');
    expect(res?.reminderIds).toEqual(['r1', 'r2']);
    expect(res?.tasks.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(seen.sendWhere).toEqual({ providerId: 'wamid.OUT7' }); // looked up by the message they answered
  });

  it('drops work that is already finished — a late tap must not reopen anything', async () => {
    const { prisma } = db({ tasks: [
      { id: 't1', title: 'Done already', kind: 'assignment', status: 'done' },
      { id: 't2', title: 'Still open', kind: 'assignment', status: 'open' },
    ] });
    const res = await resolveTap(prisma, TAP);
    expect(res?.tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('returns nothing when the message they answered is not one of ours', async () => {
    // Someone can quote-reply to their own earlier message, and a forwarded message carries a
    // context into a conversation we have never seen. Both are ordinary, neither is an error.
    const { prisma } = db({ sends: [] });
    expect(await resolveTap(prisma, TAP)).toBeNull();
  });

  it('returns nothing for a tap with no context at all', async () => {
    const { prisma } = db();
    expect(await resolveTap(prisma, { buttonId: 'done', body: 'Done' })).toBeNull();
  });

  it('returns nothing for a typed message, so the words get read as before', async () => {
    const { prisma } = db();
    expect(await resolveTap(prisma, { body: 'done sir', replyToWamid: 'wamid.OUT7' })).toBeNull();
  });

  it('survives a database that cannot answer, rather than throwing at a real person', async () => {
    const prisma: any = { reminderSend: { findMany: async () => { throw new Error('down'); } }, task: { findMany: async () => [] } };
    expect(await resolveTap(prisma, TAP)).toBeNull();
  });
});

// ---- end to end: what actually happens to the person and to the data ----
function agent(over: { sends?: any[]; tasks?: any[]; lastIn?: any; claimResult?: any } = {}) {
  const contact = { id: 'c1', name: 'Deepthi', whatsappNumber: '919812345678' };
  const state: any = { texts: [] as any[], out: [] as any[], claims: [] as any[], received: [] as any[], modelCalls: 0 };
  const lastIn = over.lastIn ?? { direction: 'in', body: 'Done', buttonId: 'done', replyToWamid: 'wamid.OUT7', createdAt: new Date() };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: { findMany: async () => [{ id: 'r1', status: 'active', subject: 'the payment', taskId: 't1' }], update: async () => undefined, updateMany: async () => undefined },
    reminderMessage: { findMany: async () => [lastIn], create: async ({ data }: any) => state.out.push(data) },
    reminderSend: { findMany: async () => over.sends ?? [{ reminder: { id: 'r1', taskId: 't1', status: 'active' } }] },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    task: {
      findUnique: async () => null,
      findMany: async () => over.tasks ?? [{ id: 't1', title: 'Confirm the payment amount needed to process', kind: 'assignment', status: 'open' }],
    },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = { isConfigured: () => true, sendText: async (to: string, body: string) => { state.texts.push({ to, body }); return { wamid: 'w1' }; } };
  const remindersSvc: any = {
    voiceComplete: async () => { state.modelCalls++; return '{"send":true,"reply":"hello","needsSandeep":false}'; },
    shareLinkFor: async () => 'https://mybrain.1site.ai/t/deepthi-a6r8',
  };
  const delegation: any = {
    recordClaim: async (i: any) => { state.claims.push(i); return over.claimResult ?? { claimed: true, task: { title: 'Confirm the payment amount needed to process' } }; },
  };
  const { ReminderAgentService } = require('./reminder-agent.service');
  const svc = new ReminderAgentService(
    prisma, postbox, remindersSvc,
    { claim: async () => null, isPending: async () => false } as any,
    {
      today: () => '2026-08-14',
      markReceived: async (id: string) => { state.received.push(id); },
      markNotReceived: async () => false, isReceived: async () => false, restDays: async () => ['Sun'],
    } as any,
    { recordPromise: async () => ({ ok: true }) } as any,
    { get: async () => '' } as any,
    { record: async () => null } as any,
    delegation,
  );
  return { svc, state };
}

describe('what happens when Deepthi taps Done (BEA-1300)', () => {
  it('claims exactly that job, and NO model is asked anything', async () => {
    const { svc, state } = agent();
    await svc.onContactReply('c1');
    expect(state.claims).toEqual([expect.objectContaining({ taskId: 't1' })]);
    expect(state.modelCalls).toBe(0); // the whole point
  });

  it('and tells her which job it was', async () => {
    const { svc, state } = agent();
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toContain('Confirm the payment amount needed to process');
  });

  it('a tap on a nudge covering TWO jobs claims nothing — it asks instead', async () => {
    const { svc, state } = agent({
      sends: [{ reminder: { id: 'r1', taskId: 't1', status: 'active' } }, { reminder: { id: 'r2', taskId: 't2', status: 'active' } }],
      tasks: [
        { id: 't1', title: 'Confirm the payment amount', kind: 'assignment', status: 'open' },
        { id: 't2', title: 'Place the PCBs', kind: 'assignment', status: 'open' },
      ],
    });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
    expect(state.modelCalls).toBe(1); // fell through to the ordinary path, which asks
  });

  it('"Still working on it" records nothing and never silences the chase', async () => {
    const { svc, state } = agent({ lastIn: { direction: 'in', body: 'Still working on it', buttonId: 'working', replyToWamid: 'wamid.OUT7', createdAt: new Date() } });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
    expect(state.texts[0].body).toMatch(/still on it/i);
    expect(state.modelCalls).toBe(0);
  });

  it('a tap on a DAILY report settles today only — never a completion', async () => {
    const { svc, state } = agent({ tasks: [{ id: 't1', title: 'Send the daily production update', kind: 'recurring', status: 'open' }] });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0); // a standing report can never be claimed
    expect(state.received).toEqual(['t1']);
    expect(state.texts[0].body).toMatch(/ask again/i);
  });

  it('a tap on work already finished changes nothing, but still answers them', async () => {
    const { svc, state } = agent({ tasks: [{ id: 't1', title: 'Old job', kind: 'assignment', status: 'done' }] });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0);
    expect(state.texts[0].body).toMatch(/nothing pending/i);
  });

  it('saying it twice does not announce it twice', async () => {
    const { svc, state } = agent({ claimResult: { claimed: false, alreadyClaimed: true, task: { title: 'x' } } });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toMatch(/already has that one/i);
    expect(state.texts[0].body).not.toMatch(/marked .* as done/i);
  });

  it('a TYPED "done" still goes the old way — the model reads it', async () => {
    const { svc, state } = agent({ lastIn: { direction: 'in', body: 'done sir', createdAt: new Date() } });
    await svc.onContactReply('c1');
    expect(state.modelCalls).toBe(1);
  });
});

describe('a tap that could mean two different things is never resolved by guessing (BEA-1300)', () => {
  it('one daily report AND one one-off on the same nudge is AMBIGUOUS', async () => {
    // The bug this replaced: it claimed the one-off, silently dropped the report, and returned as
    // though the exchange were settled — so the question was never asked either. The exact mistake
    // the ticket exists to remove, made by the code meant to remove it. (review finding)
    const { svc, state } = agent({
      sends: [{ reminder: { id: 'r1', taskId: 't1', status: 'active' } }, { reminder: { id: 'r2', taskId: 't2', status: 'active' } }],
      tasks: [
        { id: 't1', title: 'Send the daily production update', kind: 'recurring', status: 'open', scheduleDays: null },
        { id: 't2', title: 'Confirm the payment amount', kind: 'assignment', status: 'open', scheduleDays: null },
      ],
    });
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0); // nothing claimed
    expect(state.received).toHaveLength(0); // and the report is not quietly settled either
    expect(state.modelCalls).toBe(1); // fell through to the path that asks
  });

  it('does not promise "tomorrow" for a Friday-only report tapped Done', async () => {
    // BEA-1295 fixed this wording on the ordinary path. The tap path computed nothing and always
    // said "tomorrow", undoing it for anyone who taps instead of typing. (review finding)
    const { svc, state } = agent({
      tasks: [{ id: 't1', title: 'Send Friday night production status update', kind: 'recurring', status: 'open', scheduleDays: '["Fri"]' }],
    });
    await svc.onContactReply('c1');
    expect(state.received).toEqual(['t1']);
    expect(state.texts[0].body).toMatch(/next time it's due/i);
    expect(state.texts[0].body).not.toMatch(/ask again tomorrow/i);
  });

  it('two daily reports on one nudge still settle together — that is not ambiguous', async () => {
    // Jayanth owes a production update and an OT update. A message carrying his numbers settles both
    // on the ordinary path already; a tap should not be stricter than typing.
    const { svc, state } = agent({
      sends: [{ reminder: { id: 'r1', taskId: 't1', status: 'active' } }, { reminder: { id: 'r2', taskId: 't2', status: 'active' } }],
      tasks: [
        { id: 't1', title: 'Send the daily production update', kind: 'recurring', status: 'open', scheduleDays: null },
        { id: 't2', title: 'Send the OT update', kind: 'recurring', status: 'open', scheduleDays: null },
      ],
    });
    await svc.onContactReply('c1');
    expect(state.received).toEqual(['t1', 't2']);
    expect(state.modelCalls).toBe(0);
  });

  it('reads a curly apostrophe the same as a straight one', () => {
    expect(readTap({ buttonId: 'x', body: 'I’ll reply here' })).toBe('will-reply');
  });
});
