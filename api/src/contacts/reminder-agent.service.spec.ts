import { ReminderAgentService } from './reminder-agent.service';

function setup(voice: string, opts: { contact?: any; reminders?: any[]; messages?: any[]; work?: any[]; briefings?: any[] } = {}) {
  const contact = opts.contact ?? { id: 'c1', name: 'Srikar Rao', whatsappNumber: '919812345678' };
  const reminders = opts.reminders ?? [{ id: 'r1', status: 'active', subject: 'the Zigbee testing', taskId: null }];
  const messages = opts.messages ?? [{ direction: 'in', body: 'update' }];
  const state: any = { out: [] as any[], updated: {} as Record<string, any>, sent: 0, texts: [] as any[], flagged: null };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: {
      findMany: async () => reminders,
      update: async ({ where, data }: any) => { state.updated[where.id] = data; },
      updateMany: async ({ data }: any) => { state.flagged = data; },
    },
    reminderMessage: { findMany: async () => messages, create: async ({ data }: any) => state.out.push(data) },
    setting: { findUnique: async () => ({ value: '919885698665' }) }, // owner.whatsapp
    // The agent now reads the person's briefings and their open work before replying (BEA-1023).
    task: { findUnique: async () => null, findMany: async () => opts.work ?? [] },
    briefing: { findMany: async () => opts.briefings ?? [] },
  };
  const postbox: any = { isConfigured: () => true, sendText: async (to: string, body: string) => { state.texts.push({ to, body }); state.sent++; return { wamid: 'w1' }; } };
  const remindersSvc: any = { voiceComplete: async () => voice };
  return { svc: new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null, isPending: async () => false } as any, { today: () => '2026-07-27', markReceived: async () => undefined, isReceived: async () => false } as any, { recordPromise: async () => ({ ok: true }) } as any, { get: async () => '' } as any, { record: async () => null } as any), state };
}

describe('ReminderAgentService.onContactReply (BEA-742 / C2)', () => {
  it('replies but no longer auto-closes reminders from the chat (BEA-948)', async () => {
    const reminders = [
      { id: 'r1', status: 'active', subject: 'the Zigbee testing', taskId: null },
      { id: 'r2', status: 'active', subject: 'the socket pins report', taskId: null },
    ];
    const voice = '{"send":true,"reply":"Great, thanks! Will wait for the socket pins.","needsSandeep":false}';
    const { svc, state } = setup(voice, { reminders });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(1);
    expect(state.out[0]).toMatchObject({ contactId: 'c1', direction: 'out' });
    expect(state.updated['r1']).toBeUndefined(); // agent no longer marks reminders done — only the user closes them
    expect(state.updated['r2']).toBeUndefined();
  });

  it('still replies when the reminder is done or paused — the conversation never dies (BEA-948)', async () => {
    const { svc, state } = setup('{"send":true,"reply":"Thanks Jayanth, noted the 400 qty for today.","needsSandeep":false}', {
      reminders: [{ id: 'r1', status: 'done', subject: 'the production update', taskId: null }],
    });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(1); // a done reminder must STILL get a reply
    expect(state.out[0]).toMatchObject({ contactId: 'c1', direction: 'out' });
  });

  it('clears a stuck "needs you" flag once the agent handles the conversation (BEA-786)', async () => {
    const { svc, state } = setup('{"send":true,"reply":"Thanks, noted!","needsSandeep":false,"items":[]}');
    await svc.onContactReply('c1');
    expect(state.flagged).toMatchObject({ needsOwner: false }); // prior flag cleared, not left stuck
  });

  it('acknowledges even when the model returns send:false — never leaves them on read (BEA-923)', async () => {
    const { svc, state } = setup('{"send":false,"reply":"","items":[]}'); // contact wrote last ("update")
    await svc.onContactReply('c1');
    expect(state.sent).toBe(1); // a brief ack still goes out
    expect(state.out[0].body).toBe('Great, thanks Srikar!');
  });

  it('stays quiet only when the agent already replied after them (BEA-923)', async () => {
    const messages = [{ direction: 'in', body: 'ok' }, { direction: 'out', body: 'Great, thanks!' }];
    const { svc, state } = setup('{"send":false,"reply":"","items":[]}', { messages });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(0); // nothing new from the contact → no double-ack
    expect(state.out).toHaveLength(0);
  });

  it('does nothing when the contact has no active reminders', async () => {
    const { svc, state } = setup('{"send":true,"reply":"hi","items":[]}', { reminders: [] });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(0);
  });

  it('escalates: flags needs-you AND WhatsApps the owner when it cannot answer (BEA-766/767)', async () => {
    const messages = [{ direction: 'in', body: 'what is the final price?' }];
    const voice = '{"send":true,"reply":"Let me check with Sandeep and he\'ll get back to you.","needsSandeep":true,"items":[{"n":1,"resolved":false}]}';
    const { svc, state } = setup(voice, { messages });
    await svc.onContactReply('c1');
    expect(state.flagged).toMatchObject({ needsOwner: true }); // in-app flag set
    const ownerPing = state.texts.find((t: any) => t.to === '919885698665');
    expect(ownerPing).toBeTruthy(); // owner got a WhatsApp
    expect(ownerPing.body).toContain('needs you');
  });

  it('serializes concurrent replies for the same contact — no double reply (BEA-788)', async () => {
    let active = 0, maxActive = 0;
    const prisma: any = {
      contact: { findUnique: async () => ({ id: 'c1', name: 'X', whatsappNumber: '919' }) },
      reminder: { findMany: async () => [{ id: 'r1', status: 'active', subject: 'x', taskId: null }], update: async () => {}, updateMany: async () => {} },
      reminderMessage: { findMany: async () => [{ direction: 'in', body: 'hi' }], create: async () => {} },
      task: { findUnique: async () => null, findMany: async () => [] },
      briefing: { findMany: async () => [] },
      setting: { findUnique: async () => ({ value: '919885698665' }) },
    };
    const postbox: any = { isConfigured: () => true, sendText: async () => ({ wamid: 'w' }) };
    // the LLM turn tracks how many run at once
    const remindersSvc: any = { voiceComplete: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; return '{"send":true,"reply":"ok","items":[]}'; } };
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null, isPending: async () => false } as any, { today: () => '2026-07-27', markReceived: async () => undefined, isReceived: async () => false } as any, { recordPromise: async () => ({ ok: true }) } as any, { get: async () => '' } as any, { record: async () => null } as any);
    await Promise.all([svc.onContactReply('c1'), svc.onContactReply('c1')]);
    expect(maxActive).toBe(1); // the two turns never overlapped
  });

  it('skips a reply identical to one already sent (no repeats)', async () => {
    const messages = [{ direction: 'out', body: 'Great, thanks!' }, { direction: 'in', body: 'ok' }];
    const { svc, state } = setup('{"send":true,"reply":"Great,  THANKS!","items":[]}', { messages });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(0);
  });
});

/**
 * The agent must answer from the WHOLE picture — Sandeep's briefing, everything they owe, and what
 * is already finished — not just the reminder subjects. (BEA-1023)
 */
describe('the agent reads the whole picture (BEA-1023)', () => {
  function promptFor(opts: any) {
    let seen = '';
    const prisma: any = {
      contact: { findUnique: async () => ({ id: 'c1', name: 'Ramesh', whatsappNumber: '9199' }) },
      reminder: { findMany: async () => [{ id: 'r1', status: 'active', subject: 'the vendor list', taskId: 't1' }], update: async () => {}, updateMany: async () => {} },
      reminderMessage: { findMany: async () => [{ direction: 'in', body: 'where are we?' }], create: async () => {} },
      setting: { findUnique: async () => ({ value: '9198' }) },
      task: { findUnique: async () => null, findMany: async () => opts.work || [] },
      briefing: { findMany: async () => opts.briefings || [] },
    };
    const postbox: any = { isConfigured: () => true, sendText: async () => ({ wamid: 'w' }) };
    const remindersSvc: any = { voiceComplete: async (p: string) => { seen = p; return '{"send":true,"reply":"ok","needsSandeep":false,"done":[]}'; } };
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null } as any, { today: () => '2026-07-27', markReceived: async () => undefined, isReceived: async () => false } as any, { recordPromise: async () => ({ ok: true }) } as any, { get: async () => '' } as any, { record: async () => null } as any);
    return svc.onContactReply('c1').then(() => seen);
  }

  const day = (n: number) => new Date(Date.now() - n * 86400000);

  it("includes Sandeep's briefing in his own words", async () => {
    const p = await promptFor({ briefings: [{ rawText: 'He is handling the GST and owes the vendor list', createdAt: day(2) }] });
    expect(p).toContain('He is handling the GST and owes the vendor list');
  });

  it('lists everything they owe, with how long it has been open', async () => {
    const p = await promptFor({ work: [{ id: 't1', title: 'Send the vendor list', status: 'open', createdAt: day(9), claims: [], people: [] }] });
    expect(p).toContain('Send the vendor list');
    expect(p).toContain('open 9 day(s)');
  });

  it('says when they already promised a date', async () => {
    const p = await promptFor({ work: [{ id: 't1', title: 'x', status: 'open', createdAt: day(1), promisedFor: '2026-08-01', claims: [], people: [] }] });
    expect(p).toContain('they promised 2026-08-01');
  });

  it('flags work already waiting on Sandeep so it is not re-asked', async () => {
    const p = await promptFor({ work: [{ id: 't1', title: 'x', status: 'open', createdAt: day(1), claims: [{ createdAt: day(0) }], people: [] }] });
    expect(p).toContain('waiting on Sandeep to confirm');
  });

  it('names the other person when work involves someone else', async () => {
    const p = await promptFor({ work: [{ id: 't1', title: 'x', status: 'open', createdAt: day(1), claims: [], people: [{ contact: { name: 'Suresh' } }] }] });
    expect(p).toContain('also involves Suresh');
  });

  it('tells it NOT to chase recently finished work', async () => {
    const p = await promptFor({ work: [{ id: 't2', title: 'GST filing', status: 'done', createdAt: day(20), completedAt: day(3), claims: [], people: [] }] });
    expect(p).toContain('do NOT chase these again');
    expect(p).toContain('GST filing');
  });

  it('leaves old finished work out — it is not relevant any more', async () => {
    const p = await promptFor({ work: [{ id: 't2', title: 'Ancient job', status: 'done', createdAt: day(200), completedAt: day(120), claims: [], people: [] }] });
    expect(p).not.toContain('Ancient job');
  });
});

/**
 * A promise made in Sandeep's name must never go out before he knows about it — and never at all
 * if we could not reach him. (BEA-1026)
 */
describe('the owner is told BEFORE anything is promised for him (BEA-1026)', () => {
  function run(opts: { ownerReachable: boolean }) {
    const order: string[] = [];
    const texts: { to: string; body: string }[] = [];
    const prisma: any = {
      contact: { findUnique: async () => ({ id: 'c1', name: 'Ramesh', whatsappNumber: '9199' }) },
      reminder: { findMany: async () => [{ id: 'r1', status: 'active', subject: 'the vendor list', taskId: null }], update: async () => {}, updateMany: async () => {} },
      reminderMessage: { findMany: async () => [{ direction: 'in', body: 'can you approve the extra cost?' }], create: async () => { order.push('replied-to-contact'); } },
      setting: { findUnique: async () => ({ value: '9198' }) }, // owner.whatsapp
      task: { findUnique: async () => null, findMany: async () => [] },
      briefing: { findMany: async () => [] },
    };
    const postbox: any = {
      isConfigured: () => true,
      sendText: async (to: string, body: string) => {
        texts.push({ to, body });
        if (to === '9198') { order.push('told-owner'); return opts.ownerReachable ? { wamid: 'w' } : { error: 'window closed' }; }
        order.push('sent-to-contact');
        return { wamid: 'w' };
      },
      sendReminderTemplate: async () => (opts.ownerReachable ? { wamid: 't' } : { error: 'failed' }),
    };
    const remindersSvc: any = { voiceComplete: async () => '{"send":true,"reply":"I\'ll pass this to Sandeep and he\'ll get back to you.","needsSandeep":true,"done":[]}' };
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null } as any, { today: () => '2026-07-27', markReceived: async () => undefined, isReceived: async () => false } as any, { recordPromise: async () => ({ ok: true }) } as any, { get: async () => '' } as any, { record: async () => null } as any);
    return svc.onContactReply('c1').then(() => ({ order, texts }));
  }

  it('notifies Sandeep before the contact is answered', async () => {
    const { order } = await run({ ownerReachable: true });
    expect(order.indexOf('told-owner')).toBeLessThan(order.indexOf('sent-to-contact'));
  });

  it('does NOT promise a reply when Sandeep could not be reached', async () => {
    const { texts } = await run({ ownerReachable: false });
    const toContact = texts.find((t) => t.to === '9199');
    expect(toContact).toBeTruthy();
    expect(toContact!.body).not.toMatch(/get back to you/i);
    expect(toContact!.body).toMatch(/noted this down/i);
  });

  it('still answers the contact rather than leaving them on read', async () => {
    const { texts } = await run({ ownerReachable: false });
    expect(texts.some((t) => t.to === '9199')).toBe(true);
  });

  it("the owner's own alert no longer claims a promise was made for him", async () => {
    const { texts } = await run({ ownerReachable: true });
    const toOwner = texts.find((t) => t.to === '9198');
    expect(toOwner!.body).not.toMatch(/I said you'll get back/i);
  });
});


/**
 * BEA-1118: Jayanth's daily production/OT update never finishes. His real messages are figures and
 * names — they never say "done" — so the agent reports them as today's status, which satisfies the
 * DAY and is owed again tomorrow. And if the model wrongly calls a daily item finished, that must
 * not be able to end the chase: the owner was rejecting those ticks by hand every day.
 */
function dailySetup(voice: string, lastIn?: string) {
  const contact = { id: 'c1', name: 'Jayanth', whatsappNumber: '919812345678', shareSlug: 'jayanth-w5ng' };
  const reminders = [{ id: 'r1', status: 'active', subject: 'the daily production update', taskId: 't9' }];
  const messages = [{ direction: 'in', body: lastIn ?? '24/07 OT from 7:00 to 10:30 PM, 8 members: 2 fitting, 2 mounting' }];
  const state: any = { out: [], updated: {}, sent: 0, texts: [], claims: [], received: [] };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: { findMany: async () => reminders, update: async () => undefined, updateMany: async () => undefined },
    reminderMessage: { findMany: async () => messages, create: async ({ data }: any) => state.out.push(data) },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    task: {
      findUnique: async () => ({ title: 'Send the daily production update', kind: 'recurring', status: 'open' }),
      // the kind lookup for the numbered items — t9 IS recurring; the schedule lookup for the
      // Updates-tab link (BEA-1217) returns the same task with its days
      findMany: async ({ where }: any) =>
        where?.kind === 'recurring' ? [{ id: 't9' }]
        : where?.id?.in ? [{ id: 't9', scheduleDays: (state.scheduleDays !== undefined ? state.scheduleDays : null) }]
        : [],
    },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = { isConfigured: () => true, sendText: async (_to: string, body: string) => { state.texts.push(body); state.sent++; return { wamid: 'w1' }; } };
  const remindersSvc: any = { voiceComplete: async () => voice };
  const claims: any = { claim: async (i: any) => { state.claims.push(i); return { id: 'k1' }; }, isPending: async () => false };
  const recurring: any = {
    today: () => '2026-07-27',
    markReceived: async (taskId: string, day: string, quote?: string) => { state.received.push({ taskId, day, quote }); },
    markNotReceived: async () => false,
    isReceived: async () => false,
  };
  const svc = new ReminderAgentService(prisma, postbox, remindersSvc, claims, recurring, { recordPromise: async () => ({ ok: true }) } as any, { get: async () => '' } as any, { record: async () => null } as any);
  return { svc, state };
}

describe("a daily report satisfies today, never the task (BEA-1118)", () => {
  it("records today's status when the reply carries the actual update", async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"Thanks Jayanth — noted.","needsSandeep":false,"statusToday":[1]}');
    await svc.onContactReply('c1');
    expect(state.received).toEqual([{ taskId: 't9', day: '2026-07-27', quote: expect.stringContaining('8 members') }]);
    expect(state.claims).toHaveLength(0); // nothing for the owner to review
  });

  it('never claims a daily item even when the model wrongly says "done"', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"Thanks!","needsSandeep":false,"done":[1]}');
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0); // a wrong call cannot end the chase
    expect(state.received).toHaveLength(1); // treated as today's status instead
  });

  it('a garbled status number no longer loses the report — the backstop settles the day (BEA-1210)', async () => {
    // The model pointed at item 7, which does not exist. The message is still a real report,
    // so the deterministic reader settles today anyway instead of recording nothing.
    const { svc, state } = dailySetup('{"send":true,"reply":"Thanks!","needsSandeep":false,"statusToday":[7]}');
    await svc.onContactReply('c1');
    expect(state.received).toEqual([{ taskId: 't9', day: '2026-07-27', quote: expect.stringContaining('8 members') }]);
  });

  it('still replies to them either way', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"Thanks Jayanth — noted.","needsSandeep":false,"statusToday":[1]}');
    await svc.onContactReply('c1');
    expect(state.sent).toBe(1);
  });
});

/**
 * BEA-1210: on 29 Jul Jayanth sent four real reports and the day's ledger recorded none of them —
 * the model's reply simply had no statusToday, and marking the day depended entirely on it. The
 * deterministic reader that already files every update now also settles the day.
 */
describe("a report settles the day even when the model says nothing (BEA-1210)", () => {
  it('marks today received when statusToday is missing but the message reads as a report', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"Thanks Jayanth — noted."}');
    await svc.onContactReply('c1');
    expect(state.received).toEqual([{ taskId: 't9', day: '2026-07-27', quote: expect.stringContaining('8 members') }]);
    expect(state.claims).toHaveLength(0); // never a claim — nothing lands in review for this
  });

  it('does not mark twice when the model DID record the status', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"Noted.","statusToday":[1]}');
    await svc.onContactReply('c1');
    expect(state.received).toHaveLength(1);
  });

  it('does not mark twice when the model wrongly said done on the daily item', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"Noted.","done":[1]}');
    await svc.onContactReply('c1');
    expect(state.received).toHaveLength(1);
  });
});

/**
 * BEA-1217: a recurring update still owed and a reply that didn't carry it → the agent hands them
 * the door to the structured section on their page, exactly once per conversation stretch.
 */
describe('the reply points at the Updates tab when the report is still owed (BEA-1217)', () => {
  it('appends the link on a promise that is not a report', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"No problem, whenever you can."}', 'I will send the update after 6');
    await svc.onContactReply('c1');
    expect(state.received).toHaveLength(0); // a promise never settles the day (BEA-1152)
    expect(state.texts[0]).toContain('/t/jayanth-w5ng?tab=updates');
  });

  it('never adds the link when the message WAS the report — the day is settled', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"Thanks Jayanth — noted.","statusToday":[1]}');
    await svc.onContactReply('c1');
    expect(state.texts[0]).not.toContain('/t/');
  });

  it('never asks for an update on a day the report is not owed (the BEA-1147 rule)', async () => {
    const { svc, state } = dailySetup('{"send":true,"reply":"No problem, whenever you can."}', 'I will send the update after 6');
    state.scheduleDays = '["Tue"]'; // harness "today" is Monday 2026-07-27 — nothing is owed
    await svc.onContactReply('c1');
    expect(state.texts[0]).not.toContain('/t/');
  });
});

/**
 * BEA-1122: end to end — the model says item 1 is done, but the message is Madhuri's real progress
 * report. No claim may be filed, because a claim silences the chase.
 */
describe('a progress report never becomes a claim (BEA-1122)', () => {
  function assignmentSetup(lastIn: string) {
    const contact = { id: 'c1', name: 'Madhuri', whatsappNumber: '918019282143' };
    const reminders = [{ id: 'r1', status: 'active', subject: 'the BOM upload', taskId: 't1' }];
    const state: any = { out: [], sent: 0, claims: [], received: [] };
    const prisma: any = {
      contact: { findUnique: async () => contact },
      reminder: { findMany: async () => reminders, update: async () => undefined, updateMany: async () => undefined },
      reminderMessage: { findMany: async () => [{ direction: 'in', body: lastIn }], create: async ({ data }: any) => state.out.push(data) },
      setting: { findUnique: async () => ({ value: '919885698665' }) },
      // t1 is an ASSIGNMENT — the recurring path must not be what saves us here
      task: { findUnique: async () => ({ title: 'Upload all BOMs', kind: 'assignment', status: 'open' }), findMany: async () => [] },
      briefing: { findMany: async () => [] },
    };
    const postbox: any = { isConfigured: () => true, sendText: async () => { state.sent++; return { wamid: 'w1' }; } };
    const remindersSvc: any = { voiceComplete: async () => '{"send":true,"reply":"Thanks Madhuri.","needsSandeep":false,"done":[1]}' };
    const claims: any = { claim: async (i: any) => { state.claims.push(i); return { id: 'k1' }; }, isPending: async () => false };
    const recurring: any = { today: () => '2026-07-27', markReceived: async () => undefined, isReceived: async () => false };
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, claims, recurring, { recordPromise: async () => ({ ok: true }) } as any, { get: async () => '' } as any, { record: async () => null } as any);
    return { svc, state };
  }

  it('refuses the claim on her real "45 of 120" message', async () => {
    const { svc, state } = assignmentSetup('Total we have  120 BOMs to upload,upto know we uploaded 45 BOMs  in Focus ERP');
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(0); // the chase stays alive
    expect(state.sent).toBe(1); // she still gets a reply
  });

  it('still claims when she plainly says it is finished', async () => {
    const { svc, state } = assignmentSetup('All the BOMs are uploaded, all done');
    await svc.onContactReply('c1');
    expect(state.claims).toHaveLength(1);
  });
});
