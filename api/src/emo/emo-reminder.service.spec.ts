import { EmoReminderService } from './emo-reminder.service';

function make(opts: { extract: any; contact?: any; card?: any } ) {
  const updates: any[] = [];
  const card = opts.card ?? { id: 'c1', lane: 'reminder', rawTranscript: 'remind Dharmendra about the socket pins on Friday', summary: 'Reminder: Dharmendra', needsAnswer: null };
  const cards: any = { get: jest.fn(async () => card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return { ...card, ...p }; }) };
  const llm: any = { complete: jest.fn(async () => JSON.stringify(opts.extract)) };
  const contacts: any = { findByName: jest.fn(async () => opts.contact ?? null) };
  const reminders: any = { draftMessage: jest.fn(async () => ({ message: 'Hi Dharmendra, quick nudge on the socket pins.' })), create: jest.fn(async () => ({ id: 'rem1' })) };
  return { svc: new EmoReminderService(llm, cards, contacts, reminders), cards, contacts, reminders, updates };
}

describe('EmoReminderService (BEA-867)', () => {
  it('creates a real WhatsApp reminder when the contact matches', async () => {
    const { svc, reminders, updates } = make({ extract: { who: 'Dharmendra', what: 'the socket pins', when: 'Friday' }, contact: { id: 'k1', name: 'Dharmendra' } });
    await svc.handle('c1');
    expect(reminders.create).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'k1', subject: 'the socket pins' }));
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toContain('Reminder set: Dharmendra');
    expect(done.summary).toContain('Friday');
    expect(done.links[0]).toMatchObject({ kind: 'reminder', id: 'rem1' });
  });

  it('gates on Needs-you when the contact is not found (never guesses)', async () => {
    const { svc, reminders, updates } = make({ extract: { who: 'Dharmendra', what: 'the socket pins', when: '' }, contact: null });
    await svc.handle('c1');
    expect(reminders.create).not.toHaveBeenCalled();
    expect(updates[0]).toMatchObject({ status: 'needs_you' });
    expect(updates[0].needsQuestion).toContain('Dharmendra');
  });

  it('gates on Needs-you when there is no clear person', async () => {
    const { svc, updates } = make({ extract: { who: '', what: 'call the bank', when: '' } });
    await svc.handle('c1');
    expect(updates[0]).toMatchObject({ status: 'needs_you' });
    expect(updates[0].needsQuestion).toMatch(/who should i remind/i);
  });

  it('uses the answered name to resolve the contact on retry', async () => {
    const { svc, contacts } = make({ extract: { who: '', what: 'the socket pins', when: '' }, contact: { id: 'k1', name: 'Dharmendra K' }, card: { id: 'c1', lane: 'reminder', rawTranscript: 'remind about the socket pins', summary: 'Reminder', needsAnswer: 'Dharmendra K' } });
    await svc.handle('c1');
    expect(contacts.findByName).toHaveBeenCalledWith('Dharmendra K');
  });

  it('ignores a non-reminder card', async () => {
    const { svc, contacts } = make({ extract: {}, card: { id: 'c1', lane: 'task' } });
    await svc.handle('c1');
    expect(contacts.findByName).not.toHaveBeenCalled();
  });
});
