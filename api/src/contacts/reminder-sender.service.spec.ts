import { ReminderSenderService, joinSubjects } from './reminder-sender.service';

describe('joinSubjects (BEA-742)', () => {
  it('joins subjects naturally', () => {
    expect(joinSubjects(['the videos'])).toBe('the videos');
    expect(joinSubjects(['A', 'B'])).toBe('A and B');
    expect(joinSubjects(['A', 'B', 'C'])).toBe('A, B and C');
    expect(joinSubjects([])).toBe('this');
  });
});

function makePrisma(sends: any[], inboundCount = 0) {
  const state: any = { updates: [] as any[], msgs: [] as any[] };
  const prisma: any = {
    reminderSend: { findMany: async () => sends, update: async ({ where, data }: any) => state.updates.push({ id: where.id, ...data }) },
    reminderMessage: { count: async () => inboundCount, create: async ({ data }: any) => state.msgs.push(data) },
    task: { findUnique: async () => null },
  };
  return { prisma, state };
}

describe('ReminderSenderService.tick — combine per contact (BEA-742)', () => {
  it('combines a contact’s two due reminders into ONE message', async () => {
    const sends = [
      { id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'the Zigbee testing', contact: { name: 'Srikar', whatsappNumber: '919812345678' } } },
      { id: 's2', reminder: { id: 'r2', status: 'active', contactId: 'c1', subject: 'the socket pins', contact: { name: 'Srikar', whatsappNumber: '919812345678' } } },
    ];
    const { prisma, state } = makePrisma(sends);
    let sentSubject = '';
    const postbox: any = { isConfigured: () => true, sendReminderTemplate: async (_to: string, _fn: string, subj: string) => { sentSubject = subj; return { wamid: 'w' }; } };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(sentSubject).toBe('the Zigbee testing and the socket pins'); // combined subject
    expect(state.updates.filter((u: any) => u.status === 'sent')).toHaveLength(2); // both sends marked sent
    expect(state.msgs).toHaveLength(1); // ONE message stored on the contact conversation
    expect(state.msgs[0]).toMatchObject({ contactId: 'c1', direction: 'out' });
  });

  it('skips all of a contact’s nudges once they have replied', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'x', contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends, 1); // 1 inbound = contact engaged
    let sent = 0;
    const postbox: any = { isConfigured: () => true, sendReminderTemplate: async () => { sent++; return {}; } };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(sent).toBe(0);
    expect(state.updates[0].status).toBe('skipped');
  });

  it('does nothing (no DB query) when Postbox is not configured', async () => {
    let queried = false;
    const prisma: any = { reminderSend: { findMany: async () => { queried = true; return []; } } };
    await new ReminderSenderService(prisma, { isConfigured: () => false } as any).tick();
    expect(queried).toBe(false);
  });

  it('marks failed when the contact has no WhatsApp number', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'x', contact: { name: 'X', whatsappNumber: null } } }];
    const { prisma, state } = makePrisma(sends);
    const postbox: any = { isConfigured: () => true, sendReminderTemplate: async () => ({}) };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(state.updates[0]).toMatchObject({ id: 's1', status: 'failed' });
  });
});
