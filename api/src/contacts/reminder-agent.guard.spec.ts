import { fixOwnerVocative, needsFirstAck, needsAck, ackLine, watchdogAction } from './reminder-agent.service';

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

describe('needsAck — acknowledge every reply, never leave on read (BEA-923)', () => {
  it('owes an ack whenever the contact wrote the most recent message', () => {
    expect(needsAck([{ direction: 'out', body: 'reminder' }, { direction: 'in', body: 'perfect' }])).toBe(true);
    expect(needsAck([{ direction: 'out', body: 'r' }, { direction: 'in', body: 'please find the update sheet' }])).toBe(true);
  });
  it('does not owe an ack once the agent has replied after them', () => {
    expect(needsAck([{ direction: 'in', body: 'ok' }, { direction: 'out', body: 'Great, thanks!' }])).toBe(false);
  });
  it('ignores an empty last message / empty thread', () => {
    expect(needsAck([{ direction: 'in', body: '   ' }])).toBe(false);
    expect(needsAck([])).toBe(false);
  });
});

describe('ackLine — short varied acknowledgment (BEA-923)', () => {
  it('recognises a delivered file/link', () => {
    expect(ackLine('Rakesh', 'Good morning sir, please find update sheet')).toMatch(/pass this on to Sandeep/i);
    expect(ackLine('Rakesh', 'https://youtube.com/@x')).toMatch(/pass this on to Sandeep/i);
  });
  it('recognises "done"', () => {
    expect(ackLine('Swathi', "it's done")).toMatch(/noted that it's done/i);
  });
  it('falls back to a plain thanks and uses the contact name', () => {
    expect(ackLine('Deepthi', 'ok')).toBe('Great, thanks Deepthi!');
    expect(ackLine('', 'ok')).toBe('Great, thanks there!');
  });
});

describe('watchdogAction — self-healing decision (BEA-953)', () => {
  it('skips fresh replies, retries mid-age, escalates long-stuck', () => {
    expect(watchdogAction(2 * 60_000)).toBe('skip'); // 2 min — live path still has time
    expect(watchdogAction(20 * 60_000)).toBe('retry'); // 20 min — self-heal
    expect(watchdogAction(60 * 60_000)).toBe('escalate'); // 60 min — tell the owner
  });
  it('honours the grace/escalate thresholds', () => {
    expect(watchdogAction(8 * 60_000)).toBe('retry'); // exactly grace
    expect(watchdogAction(45 * 60_000)).toBe('escalate'); // exactly escalate
  });
});
