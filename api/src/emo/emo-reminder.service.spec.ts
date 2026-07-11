import { EmoReminderService } from './emo-reminder.service';

const prismaStub: any = { emoDeviceReminder: { create: jest.fn(async ({ data }: any) => ({ id: 'dr1', ...data })) } };

function make(opts: { extract: any; contacts?: any[]; card?: any }) {
  const updates: any[] = [];
  const card = opts.card ?? { id: 'c1', lane: 'reminder', rawTranscript: 'remind Dharmendra about the socket pins', summary: 'Reminder: Dharmendra', needsAnswer: null };
  const cards: any = { get: jest.fn(async () => card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return { ...card, ...p }; }) };
  const llm: any = { complete: jest.fn(async () => JSON.stringify(opts.extract)) };
  const list = opts.contacts ?? [];
  const contacts: any = { findAllByName: jest.fn(async () => list) };
  const reminders: any = { draftMessage: jest.fn(async () => ({ message: 'Hi Dharmendra, quick nudge on the socket pins.' })), create: jest.fn(async () => ({ id: 'rem1' })) };
  return { svc: new EmoReminderService(prismaStub, llm, cards, contacts, reminders), cards, contacts, reminders, updates, prismaStub };
}

const futureIstDay = (daysAhead: number) => new Date(Date.now() + 330 * 60000 + daysAhead * 86400000).toISOString().slice(0, 10);

describe('EmoReminderService (BEA-867 / BEA-875 / BEA-876)', () => {
  it('schedules a FUTURE-dated reminder when a concrete future day resolves (BEA-876)', async () => {
    const future = futureIstDay(6);
    const { svc, reminders, updates } = make({
      extract: { who: 'Dharmendra', what: 'the socket pins', when: 'next Friday', startDay: future, time: '10:00' },
      contacts: [{ id: 'k1', name: 'Dharmendra' }],
    });
    await svc.handle('c1');
    expect(reminders.create).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'k1', startDay: future, times: ['10:00'] }));
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toMatch(/^Reminder set: Dharmendra,/); // dated, not "for today"
  });

  it('defaults a future reminder with no stated time to 09:00 (BEA-876)', async () => {
    const future = futureIstDay(3);
    const { svc, reminders } = make({
      extract: { who: 'Srikar', what: 'the invoice', when: 'tomorrow', startDay: future, time: '' },
      contacts: [{ id: 'k2', name: 'Srikar' }],
    });
    await svc.handle('c1');
    expect(reminders.create).toHaveBeenCalledWith(expect.objectContaining({ startDay: future, times: ['09:00'] }));
  });
  it('creates a reminder for today when exactly one contact matches', async () => {
    const { svc, reminders, updates } = make({ extract: { who: 'Dharmendra', what: 'the socket pins', when: '' }, contacts: [{ id: 'k1', name: 'Dharmendra' }] });
    await svc.handle('c1');
    expect(reminders.create).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'k1', subject: 'the socket pins' }));
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toContain('Reminder set for today: Dharmendra');
    expect(done.links[0]).toMatchObject({ kind: 'reminder', id: 'rem1' });
  });

  it('gates on Needs-you when the contact is not found (never guesses)', async () => {
    const { svc, reminders, updates } = make({ extract: { who: 'Dharmendra', what: 'the socket pins', when: '' }, contacts: [] });
    await svc.handle('c1');
    expect(reminders.create).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'needs_you' });
    expect(updates[0].needsQuestion).toContain('Dharmendra');
  });

  it('CRITICAL: gates when two contacts share the name — never messages the wrong one (BEA-875)', async () => {
    const { svc, reminders, updates } = make({
      extract: { who: 'Dharmendra', what: 'the socket pins', when: '' },
      contacts: [{ id: 'k1', name: 'Dharmendra', whatsappNumber: '911111110001' }, { id: 'k2', name: 'Dharmendra', whatsappNumber: '911111110002' }],
    });
    await svc.handle('c1');
    expect(reminders.create).not.toHaveBeenCalled();
    expect(updates[0].status).toBe('needs_you');
    expect(updates[0].needsQuestion).toMatch(/which one/i);
    expect(updates[0].needsOptions).toHaveLength(2);
    expect(updates[0].needsOptions[0]).toContain('0001');
  });

  it('CRITICAL: does NOT silently send today for a future day — clarifies instead (BEA-875)', async () => {
    const { svc, reminders, updates } = make({ extract: { who: 'Dharmendra', what: 'the socket pins', when: 'Friday' }, contacts: [{ id: 'k1', name: 'Dharmendra' }] });
    await svc.handle('c1');
    expect(reminders.create).not.toHaveBeenCalled();
    expect(updates[0].status).toBe('needs_you');
    expect(updates[0].needsQuestion).toMatch(/today/i);
  });

  it('proceeds when the user confirms today after a future-day clarify', async () => {
    const { svc, reminders } = make({
      extract: { who: 'Dharmendra', what: 'the socket pins', when: 'Friday' },
      contacts: [{ id: 'k1', name: 'Dharmendra' }],
      card: { id: 'c1', lane: 'reminder', rawTranscript: 'remind Dharmendra about the socket pins on Friday', summary: 'Reminder', needsAnswer: 'today' },
    });
    await svc.handle('c1');
    expect(reminders.create).toHaveBeenCalled();
  });

  it('no person named = a PERSONAL reminder that rings on EMO (BEA-944) — never a question', async () => {
    prismaStub.emoDeviceReminder.create.mockClear();
    const { svc, updates } = make({ extract: { who: '', what: 'call the bank', when: '', time: '17:00' } });
    await svc.handle('c1');
    expect(prismaStub.emoDeviceReminder.create).toHaveBeenCalled();
    const data = prismaStub.emoDeviceReminder.create.mock.calls[0][0].data;
    expect(data.text).toBe('call the bank');
    expect(data.dueAt.getTime()).toBeGreaterThan(Date.now());   // never scheduled in the past
    expect(updates[0].status).toBe('done');
    expect(updates[0].summary).toMatch(/remind you/i);
  });

  it('personal reminder without a time: best-guess +2h and SAYS the assumption', async () => {
    prismaStub.emoDeviceReminder.create.mockClear();
    const { svc, updates } = make({ extract: { who: '', what: 'drink water', when: '' } });
    await svc.handle('c1');
    const data = prismaStub.emoDeviceReminder.create.mock.calls[0][0].data;
    const delta = data.dueAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(1.9 * 3600 * 1000);
    expect(delta).toBeLessThan(2.1 * 3600 * 1000);
    expect(updates[0].summary).toMatch(/no time given/i);
  });

  it('uses the answered name to resolve the contact on retry', async () => {
    const { svc, contacts } = make({ extract: { who: '', what: 'the socket pins', when: '' }, contacts: [{ id: 'k1', name: 'Dharmendra K' }], card: { id: 'c1', lane: 'reminder', rawTranscript: 'remind about the socket pins', summary: 'Reminder', needsAnswer: 'Dharmendra K' } });
    await svc.handle('c1');
    expect(contacts.findAllByName).toHaveBeenCalledWith('Dharmendra K');
  });

  it('ignores a non-reminder card', async () => {
    const { svc, contacts } = make({ extract: {}, card: { id: 'c1', lane: 'task' } });
    await svc.handle('c1');
    expect(contacts.findAllByName).not.toHaveBeenCalled();
  });
});
