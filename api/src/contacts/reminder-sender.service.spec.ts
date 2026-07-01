import { ReminderSenderService } from './reminder-sender.service';

describe('ReminderSenderService (BEA-729)', () => {
  it('sends an ACTIVE reminder via Postbox and marks it sent (first name + subject)', async () => {
    const updates: any[] = [];
    let args: any = null;
    const prisma: any = {
      reminderSend: {
        findMany: async () => [
          { id: 's1', reminder: { id: 'r1', status: 'active', subject: 'the samples', contact: { name: 'Ravi Kumar', whatsappNumber: '919812345678' } } },
        ],
        update: async ({ where, data }: any) => updates.push({ id: where.id, ...data }),
      },
      reminderMessage: { create: async () => ({}) },
    };
    const postbox: any = {
      isConfigured: () => true,
      sendReminderTemplate: async (to: string, firstName: string, subject: string) => {
        args = { to, firstName, subject };
        return { wamid: 'wamid.X', status: 'sent', error: null };
      },
    };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(args).toEqual({ to: '919812345678', firstName: 'Ravi', subject: 'the samples' });
    expect(updates[0]).toMatchObject({ id: 's1', status: 'sent', providerId: 'wamid.X' });
  });

  it('skips a paused reminder — never sends, marks the send failed', async () => {
    let sent = 0;
    const updates: any[] = [];
    const prisma: any = {
      reminderSend: {
        findMany: async () => [{ id: 's2', reminder: { id: 'r2', status: 'paused', contact: { name: 'X', whatsappNumber: '91' } } }],
        update: async ({ where, data }: any) => updates.push({ id: where.id, ...data }),
      },
    };
    const postbox: any = { isConfigured: () => true, sendReminderTemplate: async () => { sent++; return {}; } };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(sent).toBe(0);
    expect(updates[0].status).toBe('failed');
  });

  it('does nothing (no DB query) when Postbox is not configured', async () => {
    let queried = false;
    const prisma: any = { reminderSend: { findMany: async () => { queried = true; return []; } } };
    const postbox: any = { isConfigured: () => false };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(queried).toBe(false);
  });

  it('marks failed when the contact has no WhatsApp number', async () => {
    const updates: any[] = [];
    const prisma: any = {
      reminderSend: {
        findMany: async () => [{ id: 's3', reminder: { id: 'r3', status: 'active', subject: 'x', contact: { name: 'No Number', whatsappNumber: null } } }],
        update: async ({ where, data }: any) => updates.push({ id: where.id, ...data }),
      },
    };
    const postbox: any = { isConfigured: () => true, sendReminderTemplate: async () => ({ wamid: 'y' }) };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(updates[0]).toMatchObject({ id: 's3', status: 'failed' });
  });
});
