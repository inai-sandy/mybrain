import { ReminderAgentService } from './reminder-agent.service';

function setup(voice: string, reminder: any) {
  const state: any = { out: [] as any[], updated: null as any, sent: 0 };
  const prisma: any = {
    reminder: { findUnique: async () => reminder, update: async ({ data }: any) => { state.updated = data; } },
    reminderMessage: { create: async ({ data }: any) => { state.out.push(data); } },
    task: { findUnique: async () => null },
  };
  const postbox: any = { isConfigured: () => true, sendText: async () => { state.sent++; return { wamid: 'w1' }; } };
  const reminders: any = { voiceComplete: async () => voice };
  return { svc: new ReminderAgentService(prisma, postbox, reminders), state };
}

const activeReminder = (messages: any[] = [{ direction: 'in', body: 'reply' }]) => ({
  id: 'r1', status: 'active', subject: 'the samples', taskId: null,
  contact: { name: 'Ravi Kumar', whatsappNumber: '919812345678' }, messages,
});

describe('ReminderAgentService (BEA-730)', () => {
  it('replies in your voice AND closes the reminder when resolved (records outcome)', async () => {
    const { svc, state } = setup('{"reply":"Great, thanks Ravi — will wait for them!","resolved":true,"outcome":"Samples ready by Friday"}', activeReminder([{ direction: 'in', body: 'yes shipping friday' }]));
    await svc.onReply('r1');
    expect(state.sent).toBe(1);
    expect(state.out[0]).toMatchObject({ direction: 'out' });
    expect(state.out[0].body).toContain('Great');
    expect(state.updated).toMatchObject({ status: 'done', feedback: 'Samples ready by Friday' });
  });

  it('replies but does NOT close when unresolved', async () => {
    const { svc, state } = setup('{"reply":"No worries, do let me know once it moves.","resolved":false}', activeReminder());
    await svc.onReply('r1');
    expect(state.sent).toBe(1);
    expect(state.updated).toBeNull(); // reminder stays active
  });

  it('does nothing for a non-active reminder', async () => {
    const { svc, state } = setup('{"reply":"hi","resolved":true}', { ...activeReminder(), status: 'paused' });
    await svc.onReply('r1');
    expect(state.sent).toBe(0);
    expect(state.out).toHaveLength(0);
  });

  it('does not send when the AI returns no usable reply', async () => {
    const { svc, state } = setup('sorry, no json here', activeReminder());
    await svc.onReply('r1');
    expect(state.sent).toBe(0);
  });

  it('stays quiet when the agent decides not to reply (send:false) — BEA-737', async () => {
    const reminder = activeReminder([{ direction: 'out', body: 'ok, do let me know' }, { direction: 'in', body: 'sure' }]);
    const { svc, state } = setup('{"send":false,"reply":"","resolved":false}', reminder);
    await svc.onReply('r1');
    expect(state.sent).toBe(0); // non-committal → agent goes quiet, no push
    expect(state.out).toHaveLength(0);
  });

  it('skips a reply identical to one already sent — never repeats (BEA-735)', async () => {
    const reminder = activeReminder([{ direction: 'out', body: 'Great, thanks!' }, { direction: 'in', body: 'ok' }]);
    const { svc, state } = setup('{"reply":"Great,  THANKS!","resolved":false}', reminder); // same message, diff case/space
    await svc.onReply('r1');
    expect(state.sent).toBe(0); // duplicate → not sent again
    expect(state.out).toHaveLength(0);
  });

  it('still closes on resolution even when the reply is a duplicate (BEA-735)', async () => {
    const reminder = activeReminder([{ direction: 'out', body: 'Perfect, thanks!' }, { direction: 'in', body: 'done' }]);
    const { svc, state } = setup('{"reply":"Perfect, thanks!","resolved":true,"outcome":"Done"}', reminder);
    await svc.onReply('r1');
    expect(state.sent).toBe(0); // duplicate reply not re-sent
    expect(state.updated).toMatchObject({ status: 'done', feedback: 'Done' }); // but still closed
  });
});
