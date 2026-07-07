import { PostboxCallbackController } from './postbox-callback.controller';

// A contact saved WITHOUT a country code must still be matched when WhatsApp sends the reply with
// the country code in `from` — otherwise the reply is silently dropped. (BEA-787)
function setup(contacts: any[]) {
  const created: any[] = [];
  const agentCalls: string[] = [];
  const prisma: any = {
    reminderMessage: { findFirst: async () => null, create: async ({ data }: any) => created.push(data) },
    contact: {
      findFirst: async ({ where }: any) => {
        if (typeof where.whatsappNumber === 'string') return contacts.find((c) => c.whatsappNumber === where.whatsappNumber) || null;
        const suffix = where.whatsappNumber?.endsWith;
        return suffix ? contacts.find((c) => c.whatsappNumber.endsWith(suffix)) || null : null;
      },
    },
  };
  const postbox: any = { callbackKey: 'k' };
  const agent: any = { onContactReply: async (id: string) => { agentCalls.push(id); } };
  return { ctrl: new PostboxCallbackController(prisma, postbox, agent), created, agentCalls };
}

const msg = (from: string) => ({ kind: 'message', from, text: 'done', wamid: 'w1' });

describe('PostboxCallbackController — inbound number matching (BEA-787)', () => {
  it('matches a contact saved without a country code via the last 10 digits', async () => {
    const { ctrl, created, agentCalls } = setup([{ id: 'c1', whatsappNumber: '8885551234' }]);
    await ctrl.callback(msg('918885551234'), 'k'); // WhatsApp includes the country code
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ contactId: 'c1', direction: 'in' });
    expect(agentCalls).toEqual(['c1']); // the two-way agent was kicked off
  });

  it('still prefers an exact match when the full number is stored', async () => {
    const { ctrl, created } = setup([{ id: 'c2', whatsappNumber: '918885551234' }]);
    await ctrl.callback(msg('918885551234'), 'k');
    expect(created[0]).toMatchObject({ contactId: 'c2' });
  });

  it('does nothing when no contact matches', async () => {
    const { ctrl, created, agentCalls } = setup([{ id: 'c3', whatsappNumber: '919999999999' }]);
    await ctrl.callback(msg('918885551234'), 'k');
    expect(created).toHaveLength(0);
    expect(agentCalls).toHaveLength(0);
  });
});

describe('PostboxCallbackController — delivery status → chat message (BEA-916)', () => {
  function setupStatus() {
    const updates: any[] = [];
    const prisma: any = {
      reminderSend: { findFirst: async () => null, update: async () => ({}) },
      reminderMessage: { updateMany: async ({ where, data }: any) => { updates.push({ where, data }); return { count: 1 }; } },
    };
    const postbox: any = { callbackKey: 'k' };
    const agent: any = { onContactReply: async () => {} };
    return { ctrl: new PostboxCallbackController(prisma, postbox, agent), updates };
  }

  it('advances an outbound message to read, only from lower ranks', async () => {
    const { ctrl, updates } = setupStatus();
    await ctrl.callback({ kind: 'status', wamid: 'w1', status: 'read' }, 'k');
    expect(updates[0].data.status).toBe('read');
    expect(updates[0].where).toMatchObject({ wamid: 'w1', direction: 'out' });
    expect(updates[0].where.OR).toEqual([{ status: null }, { status: { in: ['sent', 'delivered'] } }]); // won't downgrade a 'read'
  });

  it('failed always applies (no rank guard) and records the error', async () => {
    const { ctrl, updates } = setupStatus();
    await ctrl.callback({ kind: 'status', wamid: 'w2', status: 'failed', error: 'bad number' }, 'k');
    expect(updates[0].where.OR).toBeUndefined();
    expect(updates[0].data).toMatchObject({ status: 'failed', error: 'bad number' });
  });
});
