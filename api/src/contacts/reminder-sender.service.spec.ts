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
      reminderSend: { count: async () => 0, deleteMany: async () => { deleted++; return {}; } },
    };
    await new ReminderSenderService(prisma, { isConfigured: () => false } as any).rollDay();
    expect(updates).toEqual([
      { id: 'r1', status: 'paused', pausedAuto: true },
      { id: 'r2', status: 'paused', pausedAuto: true },
    ]);
    expect(deleted).toBe(2); // stale queued sends cleared for each
  });

  it('does NOT pause a reminder that still has a future send queued (BEA-790)', async () => {
    const updates: any[] = [];
    const prisma: any = {
      reminder: {
        findMany: async () => [{ id: 'fresh', status: 'active', armedDay: null }], // null armedDay (e.g. swallowed write)
        update: async ({ where, data }: any) => updates.push({ id: where.id, ...data }),
      },
      // one future send is still queued → mid-lifecycle, must be left active
      reminderSend: { count: async ({ where }: any) => (where?.at?.gt ? 1 : 0), deleteMany: async () => ({}) },
    };
    await new ReminderSenderService(prisma, { isConfigured: () => false } as any).rollDay();
    expect(updates).toHaveLength(0); // not paused, sends not deleted
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

function makePrisma(sends: any[], lastInboundAt: Date | null = null) {
  const state: any = { updates: [] as any[], msgs: [] as any[], claims: [] as string[] };
  const prisma: any = {
    reminder: { findMany: async () => [], update: async () => ({}) }, // rollDay() — no stale reminders in these tests
    reminderSend: {
      findMany: async ({ where }: any = {}) => (where?.status === 'queued' && where?.at ? sends : []), // only the send-path query returns sends
      update: async ({ where, data }: any) => state.updates.push({ id: where.id, ...data }),
      updateMany: async ({ data }: any) => { state.claims.push(data.status); return { count: sends.length }; }, // claim step (BEA-775)
      deleteMany: async () => ({}),
    },
    reminderMessage: {
      // Honour the createdAt>=since filter so the 24h scoping is actually exercised (BEA-774):
      // a reply counts only if it lands inside the requested window.
      count: async ({ where }: any = {}) => {
        const since = where?.createdAt?.gte as Date | undefined;
        if (!lastInboundAt) return 0;
        return since && lastInboundAt < since ? 0 : 1;
      },
      create: async ({ data }: any) => state.msgs.push(data),
    },
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

  it('skips a contact’s nudges while they are in a LIVE conversation (replied < 24h ago) (BEA-774)', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'x', contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends, new Date(Date.now() - 60 * 60 * 1000)); // replied 1h ago
    let sent = 0;
    const postbox: any = { isConfigured: () => true, sendReminderTemplate: async () => { sent++; return {}; } };
    await new ReminderSenderService(prisma, postbox).tick();
    expect(sent).toBe(0);
    expect(state.updates[0].status).toBe('skipped');
  });

  it('STILL sends a new reminder when the last reply was over 24h ago (BEA-774)', async () => {
    const sends = [{ id: 's1', reminder: { id: 'r1', status: 'active', contactId: 'c1', subject: 'the videos', contact: { name: 'X', whatsappNumber: '919' } } }];
    const { prisma, state } = makePrisma(sends, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)); // replied 3 days ago
    let sent = 0;
    const postbox: any = { isConfigured: () => true, renderReminderTemplate, sendReminderTemplate: async () => { sent++; return { wamid: 'w' }; } };
    await new ReminderSenderService(prisma, postbox).tick();
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
    await new ReminderSenderService(prisma, postbox).tick();
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
    const svc = new ReminderSenderService(prisma, postbox);
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
    const n = await new ReminderSenderService(prisma, { isConfigured: () => false } as any).reclaimOrphanSends();
    expect(n).toBe(2);
    expect(failed.where).toEqual({ status: 'sending' });
    expect(failed.data.status).toBe('failed');
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
