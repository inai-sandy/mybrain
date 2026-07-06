import { fixOwnerVocative, needsFirstAck } from './reminder-agent.service';

describe('needsFirstAck — never leave a first "yes/ok" on read (BEA-902)', () => {
  const reminder = { direction: 'out', body: 'Hi Rakesh, a gentle reminder about the production update.' };
  it('owes an ack when the contact replies "yes"/"ok" and the agent has not replied', () => {
    expect(needsFirstAck([reminder, { direction: 'in', body: 'Yes' }])).toBe(true);
    expect(needsFirstAck([reminder, { direction: 'in', body: 'YES' }, { direction: 'in', body: 'ok' }])).toBe(true);
  });
  it('does NOT fire once the agent has already replied', () => {
    expect(needsFirstAck([reminder, { direction: 'in', body: 'Yes' }, { direction: 'out', body: 'Great, thanks!' }, { direction: 'in', body: 'ok' }])).toBe(false);
  });
  it('does NOT fire for a substantive reply (let the model handle it)', () => {
    expect(needsFirstAck([reminder, { direction: 'in', body: 'The BOM is done and uploaded to the drive.' }])).toBe(false);
  });
  it('does NOT fire with no inbound yet', () => {
    expect(needsFirstAck([reminder])).toBe(false);
  });
});

const fix = (t: string, contact = 'Dharmendra') => fixOwnerVocative(t, 'Sandeep', contact);

describe('fixOwnerVocative — never address the contact by the owner name (BEA-899)', () => {
  it('rewrites the exact live failure', () => {
    expect(fix('Got it, thanks for the update Sandeep! Sounds good.'))
      .toBe('Got it, thanks for the update Dharmendra! Sounds good.');
  });

  it('fixes greeting at the start', () => {
    expect(fix('Hi Sandeep, how are the videos coming along?'))
      .toBe('Hi Dharmendra, how are the videos coming along?');
  });

  it('fixes an ack word right before the name', () => {
    expect(fix('thanks Sandeep')).toBe('thanks Dharmendra');
    expect(fix('Great, Sandeep!')).toBe('Great, Dharmendra!');
  });

  it('KEEPS legitimate third-person mentions of the owner', () => {
    expect(fix('Let me check with Sandeep and get back to you.')).toBe('Let me check with Sandeep and get back to you.');
    expect(fix("I'll pass it to Sandeep.")).toBe("I'll pass it to Sandeep.");
    expect(fix('Sandeep will review this and confirm.')).toBe('Sandeep will review this and confirm.');
  });

  it('drops the name when the contact has no usable name', () => {
    expect(fix('thanks Sandeep', 'them')).toBe('thanks');
  });

  it('leaves normal replies untouched', () => {
    expect(fix('Sounds good, go ahead and upload them.')).toBe('Sounds good, go ahead and upload them.');
    expect(fix('')).toBe('');
  });
});
