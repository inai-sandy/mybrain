import { ReminderSenderService, joinSubjects } from './reminder-sender.service';
import { PostboxService } from './postbox.service';

/** No recurring work involved — every task in these fixtures is a plain assignment. (BEA-1119) */
const RECURRING_OFF: any = { today: () => '2026-07-27', isRestDay: async () => false, restDays: async () => [], isReceived: async () => false };

// The real renderer — reused in tests so the expected chat body is never a
// second hardcoded copy of the template. (BEA-753)
const renderReminderTemplate = (fn: string, subj: string) => new PostboxService().renderReminderTemplate(fn, subj);

describe('PostboxService.renderReminderTemplate (BEA-753)', () => {
  it('renders the approved reminder_nudge_v3 body from name + subject', () => {
    expect(renderReminderTemplate('Dharmendra', 'the support videos')).toBe(
      "Hi Dharmendra, I'm following up on behalf of Sandeep about the support videos. Could you let him know where it stands? A quick tap below is enough.",
    );
  });
});

describe('PostboxService.renderProgressNudge — the plain-chat chase (BEA-1045)', () => {
  const pb = new PostboxService();
  it('one task: asks how it is going, no list, no link', () => {
    const s = pb.renderProgressNudge('Jayanth', 1, 'the OT update');
    expect(s).toBe('Hi Jayanth, checking in again about the OT update — how is it going? Even a quick line on where it stands helps.');
  });
  it('several tasks: numbered list plus their page link', () => {
    const s = pb.renderProgressNudge('Madhuri', 2, '1) A 2) B', 'madhuri-4x2k');
    expect(s).toContain('2 things are still pending');
    expect(s).toContain('1) A 2) B');
    expect(s).toContain('https://mybrain.1site.ai/t/madhuri-4x2k');
  });
  it('no working slug: the list still reads fine without a link', () => {
    const s = pb.renderProgressNudge('Madhuri', 2, '1) A 2) B', 'unavailable');
    expect(s).not.toContain('http');
  });
});

/**
 * BEA-1160. This block used to assert the opposite: that rollDay PAUSED any chase armed on an
 * earlier day. That was the bug — on the owner's live data it had switched off 23 chases while he
 * had switched off 1. Someone who simply does not answer must keep being chased.
 *
 * His rule: a chase stops when HE stops it, when the task is marked done, or when a claim he never
 * reviewed has sat for his grace period. Never because a day ended.
 */
function rollPrisma(opts: { stale: any[]; claimAt?: Date | null; graceDays?: string; taskStatus?: string } = { stale: [] }) {
  const updates: any[] = [];
  const created: any[] = [];
  const prisma: any = {
    reminder: {
      findMany: async () => opts.stale,
      update: async ({ where, data }: any) => { updates.push({ id: where.id, ...data }); return {}; },
    },
    reminderSend: {
      count: async ({ where }: any) => (where?.at?.gt ? 0 : 0),
      deleteMany: async () => ({}),
      createMany: async ({ data }: any) => { created.push(...data); return { count: data.length }; },
      create: async ({ data }: any) => { created.push(data); return data; },
    },
    setting: { findUnique: async () => (opts.graceDays === undefined ? null : { value: opts.graceDays }) },
    taskClaim: { findFirst: async () => (opts.claimAt ? { createdAt: opts.claimAt } : null) },
    task: { findUnique: async () => ({ promisedFor: null, status: opts.taskStatus || 'open' }) },
  };
  const svc = new ReminderSenderService(prisma, { isConfigured: () => false } as any, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF);
  return { svc, updates, created };
}

describe('a chase does not die at midnight (BEA-1160)', () => {
  it('re-arms an unanswered chase instead of pausing it', async () => {
    const { svc, updates } = rollPrisma({ stale: [{ id: 'r1', status: 'active', armedDay: '2000-01-01', times: '["10:00","17:30"]', taskId: 't1' }] });
    await svc.rollDay();
    expect(updates.find((u) => u.status === 'paused')).toBeUndefined();
    expect(updates.some((u) => u.armedDay)).toBe(true); // armed for the new day
  });

  it('never writes pausedAuto again — that flag meant the app switched it off unasked', async () => {
    const { svc, updates } = rollPrisma({ stale: [{ id: 'r1', status: 'active', armedDay: null, times: '["09:00"]', taskId: null }] });
    await svc.rollDay();
    expect(updates.some((u) => u.pausedAuto)).toBe(false);
  });

  it('stops a chase whose task is already done', async () => {
    const { svc, updates } = rollPrisma({ stale: [{ id: 'r1', status: 'active', armedDay: '2000-01-01', times: '["09:00"]', taskId: 't1' }], taskStatus: 'done' });
    await svc.rollDay();
    expect(updates).toContainEqual({ id: 'r1', status: 'done' });
  });

  it("stops a chase whose claim the owner hasn't reviewed for two days", async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000);
    const { svc, updates } = rollPrisma({ stale: [{ id: 'r1', status: 'active', armedDay: '2000-01-01', times: '["09:00"]', taskId: 't1' }], claimAt: threeDaysAgo, graceDays: '2' });
    await svc.rollDay();
    expect(updates).toContainEqual({ id: 'r1', status: 'done' });
  });

  it('keeps chasing while a fresh claim is still within his grace period', async () => {
    const { svc, updates } = rollPrisma({ stale: [{ id: 'r1', status: 'active', armedDay: '2000-01-01', times: '["09:00"]', taskId: 't1' }], claimAt: new Date(), graceDays: '2' });
    await svc.rollDay();
    expect(updates.find((u) => u.status === 'done')).toBeUndefined();
  });

  it('"never" means a claim can wait forever without stopping the chase', async () => {
    const ancient = new Date(Date.now() - 400 * 86400000);
    const { svc, updates } = rollPrisma({ stale: [{ id: 'r1', status: 'active', armedDay: '2000-01-01', times: '["09:00"]', taskId: 't1' }], claimAt: ancient, graceDays: '0' });
    await svc.rollDay();
    expect(updates.find((u) => u.status === 'done')).toBeUndefined();
  });

  it('leaves a chase alone while it still has a future send queued (BEA-790)', async () => {
    const { svc, updates } = rollPrisma({ stale: [{ id: 'fresh', status: 'active', armedDay: null, times: '["09:00"]', taskId: null }] });
    (svc as any).prisma.reminderSend.count = async ({ where }: any) => (where?.at?.gt ? 1 : 0);
    await svc.rollDay();
    expect(updates).toHaveLength(0);
  });
});

describe('joinSubjects (BEA-742)', () => {
  it('joins subjects naturally', () => {
    expect(joinSubjects(['the videos'])).toBe('the videos');
    expect(joinSubjects(['A', 'B'])).toBe('A and B');
    expect(joinSubjects(['A', 'B', 'C'])).toBe('A, B and C');
    expect(joinSubjects([])).toBe('this');
  });
});

// slugFor() reads contact.shareSlug; null here so tests exercise the contacts.share() path. (BEA-1041)
function makePrisma(sends: any[], lastInboundAt: Date | null = null) {
  const state: any = { updates: [] as any[], msgs: [] as any[], claims: [] as string[] };
  const prisma: any = {
    contact: { findUnique: async () => null },
    reminder: { findMany: async () => [], update: async () => ({}) }, // rollDay() — no stale reminders in these tests
    reminderSend: {
      findMany: async ({ where }: any = {}) => (where?.status === 'queued' && where?.at ? sends : []), // only the send-path query returns sends
      update: async ({ where, data }: any) => state.updates.push({ id: where.id, ...data }),
      updateMany: async ({ data }: any) => { state.claims.push(data.status); return { count: sends.length }; }, // claim step (BEA-775)
      deleteMany: async () => ({}),
    },
    reminderMessage: {
      // The sender reads the LATEST inbound reply and decides from its age (BEA-1045).
      findFirst: async () => (lastInboundAt ? { createdAt: lastInboundAt } : null),
      create: async ({ data }: any) => state.msgs.push(data),
    },
    task: { findUnique: async () => null },
  };
  return { prisma, state };
}

describe('ReminderSenderService.tick — combine per contact (BEA-742)', () => {
  it('combines a contact’s two due reminders into ONE numbered message with their page button (BEA-1041)', async () => {
    const sends = [
      { id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'the Zigbee testing', createdAt: new Date(1), contact: { name: 'Srikar', whatsappNumber: '919812345678' } } },
      { id: 's2', reminder: { id: 'r2', status: 'active', contactId: 'c1', subject: 'the socket pins', createdAt: new Date(2), contact: { name: 'Srikar', whatsappNumber: '919812345678' } } },
    ];
    const { prisma, state } = makePrisma(sends);
    let got: any = null;
    const postbox: any = {
      isConfigured: () => true,
      renderReminderTemplate,
      renderTaskListTemplate: (fn: string, n: number, list: string) => `Hi ${fn}, following up on behalf of Sandeep — ${n} things are pending with him: ${list}. Just reply here with where things stand.`,
      sendTaskListTemplate: async (_to: string, fn: string, n: number, list: string, slug: string) => { got = { fn, n, list, slug }; return { wamid: 'w', status: 'sent', error: null }; },
      sendReminderTemplate: async () => { throw new Error('must not fall back when the list template works'); },
    };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'srikar-4x2k' }) } as any, RECURRING_OFF).tick();
    // Numbered in reminder-age order — the SAME numbers the agent uses, so "2 is done" means the
    // same task on both sides.
    expect(got).toEqual({ fn: 'Srikar', n: 2, list: '1) the Zigbee testing 2) the socket pins', slug: 'srikar-4x2k' });
    expect(state.updates.filter((u: any) => u.status === 'sent')).toHaveLength(2);
    expect(state.msgs).toHaveLength(1); // still ONE message on the conversation
    expect(state.msgs[0].body).toContain('1) the Zigbee testing 2) the socket pins');
  });

  it('falls back to the single-task template wording when the list template is not approved yet (BEA-1041)', async () => {
    const sends = [
      { id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'A', createdAt: new Date(1), contact: { name: 'Srikar', whatsappNumber: '919' } } },
      { id: 's2', reminder: { id: 'r2', status: 'active', contactId: 'c1', subject: 'B', createdAt: new Date(2), contact: { name: 'Srikar', whatsappNumber: '919' } } },
    ];
    const { prisma, state } = makePrisma(sends);
    let fallbackSubject = '';
    const postbox: any = {
      isConfigured: () => true,
      renderReminderTemplate,
      renderTaskListTemplate: () => 'unused',
      sendTaskListTemplate: async () => ({ wamid: null, status: 'failed', error: 'template not approved' }),
      sendReminderTemplate: async (_to: string, _fn: string, subj: string) => { fallbackSubject = subj; return { wamid: 'w' }; },
    };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 's' }) } as any, RECURRING_OFF).tick();
    expect(fallbackSubject).toBe('A and B'); // the old combined wording still goes out
    expect(state.updates.filter((u: any) => u.status === 'sent')).toHaveLength(2);
  });

  it('a single due reminder still uses the original template untouched', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'the Zigbee testing', createdAt: new Date(1), contact: { name: 'Srikar', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends);
    let single = '';
    const postbox: any = {
      isConfigured: () => true,
      renderReminderTemplate,
      sendTaskListTemplate: async () => { throw new Error('must not use the list template for one task'); },
      sendReminderTemplate: async (_to: string, _fn: string, subj: string) => { single = subj; return { wamid: 'w' }; },
    };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 's' }) } as any, RECURRING_OFF).tick();
    expect(single).toBe('the Zigbee testing');
    expect(state.msgs).toHaveLength(1);
  });

  it('holds a nudge only while the conversation is genuinely live (replied < 1h ago) (BEA-1045)', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'x', contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends, new Date(Date.now() - 30 * 60 * 1000)); // replied 30 min ago
    let sent = 0;
    const postbox: any = { isConfigured: () => true, sendText: async () => { sent++; return {}; }, sendReminderTemplate: async () => { sent++; return {}; } };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).tick();
    expect(sent).toBe(0);
    expect(state.updates[0].status).toBe('skipped');
  });

  it('a morning reply does NOT kill the evening chase — it goes as a plain chat message, not the template (BEA-1045)', async () => {
    // This is the bug the owner reported on 2026-07-22: Madhuri and Jayanth replied in the
    // morning, and every noon/evening chase was silently skipped for 24 hours.
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'the OT update', createdAt: new Date(1), contact: { name: 'Jayanth', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends, new Date(Date.now() - 6 * 60 * 60 * 1000)); // replied 6h ago
    let plain = '';
    const postbox: any = {
      isConfigured: () => true,
      renderProgressNudge: (fn: string, n: number, s: string) => new PostboxService().renderProgressNudge(fn, n, s),
      sendText: async (_to: string, body: string) => { plain = body; return { wamid: 'w', status: 'sent', error: null }; },
      sendReminderTemplate: async () => { throw new Error('must not fire the template inside an open chat'); },
      sendTaskListTemplate: async () => { throw new Error('must not fire the template inside an open chat'); },
    };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).tick();
    expect(plain).toContain('checking in again about the OT update');
    expect(state.updates[0].status).toBe('sent');
    expect(state.msgs[0].body).toBe(plain); // the chat mirror shows exactly what went out
  });

  it('the plain-chat chase lists multiple tasks with the page link (BEA-1045)', async () => {
    const sends = [
      { id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'A', createdAt: new Date(1), contact: { name: 'Madhuri', whatsappNumber: '919' } } },
      { id: 's2', reminder: { id: 'r2', status: 'active', contactId: 'c1', subject: 'B', createdAt: new Date(2), contact: { name: 'Madhuri', whatsappNumber: '919' } } },
    ];
    const { prisma, state } = makePrisma(sends, new Date(Date.now() - 6 * 60 * 60 * 1000));
    let plain = '';
    const postbox: any = {
      isConfigured: () => true,
      renderProgressNudge: (fn: string, n: number, s: string, slug?: string | null) => new PostboxService().renderProgressNudge(fn, n, s, slug),
      sendText: async (_to: string, body: string) => { plain = body; return { wamid: 'w', status: 'sent', error: null }; },
      sendTaskListTemplate: async () => { throw new Error('must not fire the template inside an open chat'); },
    };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'madhuri-4x2k' }) } as any, RECURRING_OFF).tick();
    expect(plain).toContain('1) A 2) B');
    expect(plain).toContain('https://mybrain.1site.ai/t/madhuri-4x2k');
    expect(state.updates.filter((u: any) => u.status === 'sent')).toHaveLength(2);
  });

  it('falls back to the template when the plain message bounces (session actually closed) (BEA-1045)', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'the videos', createdAt: new Date(1), contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends, new Date(Date.now() - 23 * 60 * 60 * 1000)); // our clock says open; Meta's says closed
    let templated = 0;
    const postbox: any = {
      isConfigured: () => true,
      renderReminderTemplate,
      renderProgressNudge: (fn: string, n: number, s: string) => new PostboxService().renderProgressNudge(fn, n, s),
      sendText: async () => ({ wamid: null, status: 'failed', error: 're-engagement required' }),
      sendReminderTemplate: async () => { templated++; return { wamid: 'w' }; },
    };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).tick();
    expect(templated).toBe(1); // the chase never silently dies
    expect(state.updates[0].status).toBe('sent');
  });

  it('STILL sends a new reminder when the last reply was over 24h ago (BEA-774)', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'the videos', contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)); // replied 3 days ago
    let sent = 0;
    const postbox: any = { isConfigured: () => true, renderReminderTemplate, sendReminderTemplate: async () => { sent++; return { wamid: 'w' }; } };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).tick();
    expect(sent).toBe(1); // the stale conversation must not block a fresh reminder
    expect(state.updates[0].status).toBe('sent');
  });

  it('claims due sends (queued → sending) BEFORE calling Postbox (BEA-775)', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'x', contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends);
    const order: string[] = [];
    const postbox: any = {
      isConfigured: () => true, renderReminderTemplate,
      sendReminderTemplate: async () => { order.push('send'); return { wamid: 'w' }; },
    };
    // record the claim before the send by wrapping updateMany
    const origUpdateMany = prisma.reminderSend.updateMany;
    prisma.reminderSend.updateMany = async (a: any) => { order.push('claim'); return origUpdateMany(a); };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).tick();
    expect(state.claims).toContain('sending'); // rows were claimed
    expect(order).toEqual(['claim', 'send']); // claim happens first, so an overlapping tick can't re-send
  });

  it('does not let two overlapping ticks both send (re-entrancy guard) (BEA-775)', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'x', contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma } = makePrisma(sends);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let sent = 0;
    const postbox: any = { isConfigured: () => true, renderReminderTemplate, sendReminderTemplate: async () => { sent++; await gate; return { wamid: 'w' }; } };
    const svc = new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF);
    const p1 = svc.tick();          // sets sending=true synchronously, then blocks in the send
    const p2 = svc.tick();          // sees sending=true → returns immediately, no send
    await p2;
    release();                      // let the first tick's single send complete
    await p1;
    expect(sent).toBe(1);           // exactly one send total — the overlap did NOT double-send
  });

  it('fails orphaned in-flight sends on boot, never re-sending (BEA-775)', async () => {
    let failed: any = null;
    const prisma: any = { reminderSend: { updateMany: async ({ where, data }: any) => { failed = { where, data }; return { count: 2 }; } } };
    const n = await new ReminderSenderService(prisma, { isConfigured: () => false } as any, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).reclaimOrphanSends();
    expect(n).toBe(2);
    expect(failed.where).toEqual({ status: 'sending' });
    expect(failed.data.status).toBe('failed');
  });

  it('does nothing (no DB query) when Postbox is not configured', async () => {
    let queried = false;
    const prisma: any = { reminder: { findMany: async () => [], update: async () => ({}) }, reminderSend: { findMany: async () => { queried = true; return []; }, deleteMany: async () => ({}) } };
    await new ReminderSenderService(prisma, { isConfigured: () => false } as any, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).tick();
    expect(queried).toBe(false);
  });

  it('marks failed when the contact has no WhatsApp number', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'x', contact: { name: 'X', whatsappNumber: null } } }];
    const { prisma, state } = makePrisma(sends);
    const postbox: any = { isConfigured: () => true, sendReminderTemplate: async () => ({}) };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF).tick();
    expect(state.updates[0]).toMatchObject({ id: 's1', status: 'failed' });
  });
});

/**
 * A real chase must not die at midnight, and must never message someone about work they have
 * already finished. These are the two failures the old one-day lifecycle caused. (BEA-1021)
 */
describe('rollDay — a daily chase repeats instead of pausing (BEA-1021)', () => {
  function harness(reminders: any[], task: any | null) {
    const updates: any[] = [];
    const created: any[] = [];
    let deleted = 0;
    const prisma: any = {
      reminder: {
        findMany: async () => reminders,
        update: async ({ where, data }: any) => { updates.push({ id: where.id, ...data }); return {}; },
      },
      reminderSend: {
        count: async () => 0,
        deleteMany: async () => { deleted++; return {}; },
        create: async ({ data }: any) => { created.push(data); return data; },
      },
      task: { findUnique: async () => task },
      // BEA-1160: rollDay now reads the grace setting and looks for a pending claim.
      setting: { findUnique: async () => null },
      taskClaim: { findFirst: async () => null },
    };
    return { svc: new ReminderSenderService(prisma, { isConfigured: () => false } as any, { share: async () => ({ slug: 'x-1234' }) } as any, RECURRING_OFF), updates, created, get deleted() { return deleted; } };
  }

  it('re-arms a daily chase for the new day instead of pausing it', async () => {
    // Pin the clock to mid-morning IST: with real time this test silently depended on the hour it
    // ran at — after 17:00 IST both chase times were "already past today" and no send was created.
    jest.useFakeTimers({ now: new Date('2026-07-24T06:00:00Z') }); // 11:30 IST
    try {
      const h = harness([{ id: 'c1', status: 'active', armedDay: '2000-01-01', repeat: 'daily', times: '["09:00","17:00"]', taskId: 't1' }], { status: 'open', title: 'x' });
      await h.svc.rollDay();
      expect(h.updates.some((u) => u.status === 'paused')).toBe(false);
      const armed = h.updates.find((u) => u.armedDay);
      expect(armed).toBeTruthy();
      expect(armed.pausedAuto).toBe(false);
      expect(h.created.length).toBeGreaterThan(0); // today's remaining send (17:00) put on the board
    } finally {
      jest.useRealTimers();
    }
  });

  it('STOPS a daily chase once the task is done — no more messages', async () => {
    const h = harness([{ id: 'c1', status: 'active', armedDay: '2000-01-01', repeat: 'daily', times: '["09:00"]', taskId: 't1' }], { status: 'done', title: 'x' });
    await h.svc.rollDay();
    expect(h.updates).toEqual([{ id: 'c1', status: 'done' }]);
    expect(h.created).toHaveLength(0);
  });

  it('stops a chase whose task was deleted rather than chasing about nothing', async () => {
    const h = harness([{ id: 'c1', status: 'active', armedDay: '2000-01-01', repeat: 'daily', times: '["09:00"]', taskId: 'gone' }], null);
    await h.svc.rollDay();
    expect(h.updates).toEqual([{ id: 'c1', status: 'done' }]);
  });

  it('a ONE-OFF chase is re-armed too, not paused (BEA-1160)', async () => {
    // This used to expect { status: 'paused', pausedAuto: true } — the bug. A one-off chase that
    // nobody answered was switched off at midnight, which is exactly when it should keep going.
    const h = harness([{ id: 'r1', status: 'active', armedDay: '2000-01-01', repeat: 'none', times: '["09:00"]', taskId: null }], null);
    await h.svc.rollDay();
    expect(h.updates.find((u: any) => u.status === 'paused')).toBeUndefined();
    expect(h.updates.some((u: any) => u.armedDay)).toBe(true);
  });

  it('a chase with no usable times is still RE-ARMED with the 09:00 fallback rather than going silent', async () => {
    const h = harness([{ id: 'c1', status: 'active', armedDay: '2000-01-01', repeat: 'daily', times: 'not json', taskId: 't1' }], { status: 'open', title: 'x' });
    await h.svc.rollDay();
    // Slots only land if 09:00 IST is still ahead of the real clock, so asserting on `created`
    // made this test pass or fail by time of day. The invariant is the re-arm itself.
    const armed = h.updates.find((u: any) => u.armedDay);
    expect(armed).toBeTruthy();
    expect(armed.pausedAuto).toBe(false);
  });
});

/**
 * BEA-1119: a standing daily report is owed on working days only, and once today's has arrived the
 * chasing stops until tomorrow. Neither ends the chase — it returns on the next working day.
 */
describe('the sender honours rest days and today\'s status (BEA-1119)', () => {
  function dailyPrisma() {
    const sends = [
      { id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', taskId: 't9', subject: 'the daily production update', createdAt: new Date(1), contact: { name: 'Jayanth', whatsappNumber: '919812345678' } } },
    ];
    const state: any = { updates: [], msgs: [], claims: [] };
    const prisma: any = {
      contact: { findUnique: async () => null },
      reminder: { findMany: async () => [], update: async () => ({}) },
      reminderSend: {
        findMany: async ({ where }: any = {}) => (where?.status === 'queued' && where?.at ? sends : []),
        update: async ({ where, data }: any) => state.updates.push({ id: where.id, ...data }),
        updateMany: async () => ({ count: 1 }),
        deleteMany: async () => ({}),
      },
      reminderMessage: { findFirst: async () => null, create: async ({ data }: any) => state.msgs.push(data) },
      taskClaim: { count: async () => 0 },
      task: { findUnique: async () => ({ title: 'Send the daily production update', kind: 'recurring' }) },
    };
    return { prisma, state };
  }
  const noSend: any = {
    isConfigured: () => true,
    renderReminderTemplate,
    sendReminderTemplate: async () => { throw new Error('must not chase — nothing is owed'); },
    sendText: async () => { throw new Error('must not chase — nothing is owed'); },
  };

  it('sends nothing on a rest day, and says why', async () => {
    const { prisma, state } = dailyPrisma();
    const recurring: any = { today: () => '2026-07-26', isRestDay: async () => true, restDays: async () => ['Sun'], isReceived: async () => false };
    await new ReminderSenderService(prisma, noSend, { share: async () => ({ slug: 'j-1' }) } as any, recurring).tick();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ id: 's1', status: 'skipped', error: 'not owed today' });
  });

  it("sends nothing once today's update has already come in", async () => {
    const { prisma, state } = dailyPrisma();
    const recurring: any = { today: () => '2026-07-27', isRestDay: async () => false, restDays: async () => ['Sun'], isReceived: async () => true };
    await new ReminderSenderService(prisma, noSend, { share: async () => ({ slug: 'j-1' }) } as any, recurring).tick();
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).toMatchObject({ id: 's1', status: 'skipped', error: "today's update already came in" });
  });

  it("chases on a working day when today's has NOT arrived, asking for today's copy", async () => {
    const { prisma, state } = dailyPrisma();
    let asked: any = null;
    const postbox: any = {
      isConfigured: () => true,
      renderReminderTemplate,
      sendReminderTemplate: async (_to: string, fn: string, subject: string) => { asked = { fn, subject }; return { wamid: 'w', status: 'sent', error: null }; },
    };
    const recurring: any = { today: () => '2026-07-27', isRestDay: async () => false, restDays: async () => ['Sun'], isReceived: async () => false };
    await new ReminderSenderService(prisma, postbox, { share: async () => ({ slug: 'j-1' }) } as any, recurring).tick();
    expect(asked).toEqual({ fn: 'Jayanth', subject: "today's production update" });
    expect(state.updates.filter((u: any) => u.status === 'sent')).toHaveLength(1);
  });
});
