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
  return { svc: new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null, isPending: async () => false } as any, { recordPromise: async () => ({ ok: true }) } as any), state };
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
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null, isPending: async () => false } as any, { recordPromise: async () => ({ ok: true }) } as any);
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
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null } as any, { recordPromise: async () => ({ ok: true }) } as any);
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
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null } as any, { recordPromise: async () => ({ ok: true }) } as any);
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
