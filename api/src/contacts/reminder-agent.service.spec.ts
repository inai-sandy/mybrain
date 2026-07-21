import { ReminderAgentService } from './reminder-agent.service';

function setup(voice: string, opts: { contact?: any; reminders?: any[]; messages?: any[] } = {}) {
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
    task: { findUnique: async () => null },
  };
  const postbox: any = { isConfigured: () => true, sendText: async (to: string, body: string) => { state.texts.push({ to, body }); state.sent++; return { wamid: 'w1' }; } };
  const remindersSvc: any = { voiceComplete: async () => voice };
  return { svc: new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null, isPending: async () => false } as any), state };
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
      setting: { findUnique: async () => ({ value: '919885698665' }) },
      task: { findUnique: async () => null },
    };
    const postbox: any = { isConfigured: () => true, sendText: async () => ({ wamid: 'w' }) };
    // the LLM turn tracks how many run at once
    const remindersSvc: any = { voiceComplete: async () => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; return '{"send":true,"reply":"ok","items":[]}'; } };
    const svc = new ReminderAgentService(prisma, postbox, remindersSvc, { claim: async () => null, isPending: async () => false } as any);
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
