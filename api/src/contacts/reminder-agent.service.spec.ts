import { ReminderAgentService } from './reminder-agent.service';

function setup(voice: string, opts: { contact?: any; reminders?: any[]; messages?: any[] } = {}) {
  const contact = opts.contact ?? { id: 'c1', name: 'Srikar Rao', whatsappNumber: '919812345678' };
  const reminders = opts.reminders ?? [{ id: 'r1', status: 'active', subject: 'the Zigbee testing', taskId: null }];
  const messages = opts.messages ?? [{ direction: 'in', body: 'update' }];
  const state: any = { out: [] as any[], updated: {} as Record<string, any>, sent: 0 };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: { findMany: async () => reminders, update: async ({ where, data }: any) => { state.updated[where.id] = data; } },
    reminderMessage: { findMany: async () => messages, create: async ({ data }: any) => state.out.push(data) },
    task: { findUnique: async () => null },
  };
  const postbox: any = { isConfigured: () => true, sendText: async () => { state.sent++; return { wamid: 'w1' }; } };
  const remindersSvc: any = { voiceComplete: async () => voice };
  return { svc: new ReminderAgentService(prisma, postbox, remindersSvc), state };
}

describe('ReminderAgentService.onContactReply (BEA-742 / C2)', () => {
  it('replies once and closes ONLY the item the contact addressed (partial reply)', async () => {
    const reminders = [
      { id: 'r1', status: 'active', subject: 'the Zigbee testing', taskId: null },
      { id: 'r2', status: 'active', subject: 'the socket pins report', taskId: null },
    ];
    const voice = '{"send":true,"reply":"Great, thanks! Will wait for the socket pins.","items":[{"n":1,"resolved":true,"outcome":"Zigbee testing done"},{"n":2,"resolved":false}]}';
    const { svc, state } = setup(voice, { reminders });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(1);
    expect(state.out[0]).toMatchObject({ contactId: 'c1', direction: 'out' });
    expect(state.updated['r1']).toMatchObject({ status: 'done', feedback: 'Zigbee testing done' }); // resolved item closed
    expect(state.updated['r2']).toBeUndefined(); // other item stays open
  });

  it('stays quiet when the agent decides not to reply (send:false)', async () => {
    const { svc, state } = setup('{"send":false,"reply":"","items":[]}');
    await svc.onContactReply('c1');
    expect(state.sent).toBe(0);
    expect(state.out).toHaveLength(0);
  });

  it('does nothing when the contact has no active reminders', async () => {
    const { svc, state } = setup('{"send":true,"reply":"hi","items":[]}', { reminders: [] });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(0);
  });

  it('skips a reply identical to one already sent (no repeats)', async () => {
    const messages = [{ direction: 'out', body: 'Great, thanks!' }, { direction: 'in', body: 'ok' }];
    const { svc, state } = setup('{"send":true,"reply":"Great,  THANKS!","items":[]}', { messages });
    await svc.onContactReply('c1');
    expect(state.sent).toBe(0);
  });
});
