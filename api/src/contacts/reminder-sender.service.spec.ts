import { ReminderSenderService, joinSubjects } from './reminder-sender.service';
import { PostboxService } from './postbox.service';

// The real renderer — reused in tests so the expected chat body is never a
// second hardcoded copy of the template. (BEA-753)
const renderReminderTemplate = (fn: string, subj: string) => new PostboxService().renderReminderTemplate(fn, subj);

describe('PostboxService.renderReminderTemplate (BEA-753)', () => {
  it('renders the approved reminder_nudge body from name + subject', () => {
    expect(renderReminderTemplate('Dharmendra', 'the support videos')).toBe(
      'Hi Dharmendra, just a gentle reminder about the support videos. Do let me know where it stands whenever you get a chance. Thanks!',
    );
  });
});

describe('rollDay — one-day auto-pause (BEA-764)', () => {
  it('pauses active reminders armed on a past day (or never armed) and clears their queued sends', async () => {
    const updates: any[] = [];
    let deleted = 0;
    const prisma: any = {
      reminder: {
        // real prisma applies the where; the mock returns the stale set it would match
        findMany: async () => [
          { id: 'r1', status: 'active', armedDay: null },
          { id: 'r2', status: 'active', armedDay: '2000-01-01' },
        ],
        update: async ({ where, data }: any) => updates.push({ id: where.id, ...data }),
      },
      reminderSend: { deleteMany: async () => { deleted++; return {}; } },
    };
    await new ReminderSenderService(prisma, { isConfigured: () => false } as any).rollDay();
    expect(updates).toEqual([
      { id: 'r1', status: 'paused', pausedAuto: true },
      { id: 'r2', status: 'paused', pausedAuto: true },
    ]);
    expect(deleted).toBe(2); // stale queued sends cleared for each
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

function makePrisma(sends: any[], inboundCount = 0) {
  const state: any = { updates: [] as any[], msgs: [] as any[] };
  const prisma: any = {
    reminder: { findMany: async () => [], update: async () => ({}) }, // rollDay() — no stale reminders in these tests
    reminderSend: {
      findMany: async ({ where }: any = {}) => (where?.status === 'queued' && where?.at ? sends : []), // only the send-path query returns sends
      update: async ({ where, data }: any) => state.updates.push({ id: where.id, ...data }),
      deleteMany: async () => ({}),
    },
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
    let sentName = '';
    let sentSubject = '';
    const postbox: any = {
      isConfigured: () => true,
      renderReminderTemplate,
      sendReminderTemplate: async (_to: string, fn: string, subj: string) => { sentName = fn; sentSubject = subj; return { wamid: 'w' }; },
    };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(sentSubject).toBe('the Zigbee testing and the socket pins'); // combined subject
    expect(state.updates.filter((u: any) => u.status === 'sent')).toHaveLength(2); // both sends marked sent
    expect(state.msgs).toHaveLength(1); // ONE message stored on the contact conversation
    expect(state.msgs[0]).toMatchObject({ contactId: 'c1', direction: 'out' });
    // The stored chat body is EXACTLY what the template renders with the same
    // name + subject that were sent — no separate hardcoded copy. (BEA-753)
    expect(state.msgs[0].body).toBe(renderReminderTemplate(sentName, sentSubject));
    expect(state.msgs[0].body).toContain('the Zigbee testing and the socket pins');
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
    const prisma: any = { reminder: { findMany: async () => [], update: async () => ({}) }, reminderSend: { findMany: async () => { queried = true; return []; }, deleteMany: async () => ({}) } };
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
