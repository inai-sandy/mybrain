import { fixOwnerVocative, needsFirstAck, needsAck, ackLine, watchdogAction, trimThread, THREAD_KEEP, looksLikePartialProgress } from './reminder-agent.service';

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
  it('recognises "done" — but NEVER says it was recorded (BEA-1293)', () => {
    // This line only fires when the model returned nothing to send, which means nothing was
    // recorded. The old wording — "noted that it's done!" — said the opposite, so a lost report and
    // a saved one produced the identical message and the owner's team stopped trusting the replies.
    // The real confirmation is built in `claim-reply.ts` and appears only when a claim landed.
    const line = ackLine('Swathi', "it's done");
    expect(line).toMatch(/passed this to Sandeep/i);
    expect(line.toLowerCase()).not.toContain("noted that it's done");
    expect(line).not.toMatch(/marked .* as done/i);
    expect(line).not.toMatch(/won't get reminders/i);
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

/**
 * BEA-1115: the agent used to read EVERY message ever exchanged, so the prompt grew forever.
 * It now keeps the tail — the last few of THEIR messages plus our replies in between, so it can
 * still read its own questions and answer "yes" / "the second one".
 */
describe('trimThread — keep the recent exchange, not the whole history', () => {
  const inn = (body: string) => ({ direction: 'in', body });
  const out = (body: string) => ({ direction: 'out', body });

  it('keeps our replies sitting between their messages', () => {
    const thread = [
      inn('old one'), out('old answer'),
      inn('q1'), out('a1'), inn('q2'), out('a2'), inn('q3'), out('a3'), inn('q4'), out('a4'),
    ];
    const kept = trimThread(thread);
    expect(kept.filter((m) => m.direction === 'in')).toHaveLength(4);
    expect(kept.some((m) => m.direction === 'out')).toBe(true); // our side survives
    expect(kept.map((m) => m.body)).not.toContain('old one'); // the ancient part is dropped
  });

  it('reads its own question, so a bare "the second one" is still answerable', () => {
    const thread = [
      out('Which of the 3 do you mean?'),
      inn('the second one'),
    ];
    const kept = trimThread(thread);
    expect(kept.map((m) => m.body)).toContain('Which of the 3 do you mean?');
  });

  it('a burst of their messages cannot swallow the whole window', () => {
    // 12 messages fired seconds apart, then the cap must still hold
    const burst = Array.from({ length: 20 }, (_, i) => inn(`burst ${i}`));
    const kept = trimThread([out('earlier question'), ...burst]);
    expect(kept.length).toBeLessThanOrEqual(12);
  });

  it('keeps everything when the conversation is still short', () => {
    const thread = [inn('hi'), out('hello'), inn('done?')];
    expect(trimThread(thread)).toHaveLength(3);
  });

  it('handles an empty thread', () => {
    expect(trimThread([])).toEqual([]);
  });

  it('always ends on the newest message', () => {
    const thread = Array.from({ length: 40 }, (_, i) => (i % 2 ? out(`a${i}`) : inn(`q${i}`)));
    const kept = trimThread(thread);
    expect(kept[kept.length - 1]).toBe(thread[thread.length - 1]);
  });

  it('never returns more than the cap, however long the history', () => {
    const thread = Array.from({ length: 500 }, (_, i) => (i % 2 ? out(`a${i}`) : inn(`q${i}`)));
    expect(trimThread(thread).length).toBeLessThanOrEqual(THREAD_KEEP.maxMessages);
  });
});

/**
 * BEA-1122: the bug that started all of this. The agent read Madhuri's "Total we have 120 BOMs to
 * upload, upto know we uploaded 45 BOMs" as DONE. That filed a claim, the chase went quiet waiting
 * for a review nobody knew about, and she was not chased for two days. The prompt already forbade
 * it, so the guard has to be deterministic.
 */
describe('looksLikePartialProgress — progress is not completion', () => {
  it("catches Madhuri's real message that was misread as done", () => {
    expect(looksLikePartialProgress('Total we have  120 BOMs to upload,upto know we uploaded 45 BOMs  in Focus ERP')).toBe(true);
  });

  it("catches her second one — an ongoing state, not a finished job", () => {
    expect(looksLikePartialProgress('We are using the kitflow daily and updating the data in it')).toBe(true);
  });

  it('catches a count short of the total', () => {
    expect(looksLikePartialProgress('45 of 120 done')).toBe(true);
    expect(looksLikePartialProgress('uploaded 45/120')).toBe(true);
    expect(looksLikePartialProgress('30 out of 200 finished')).toBe(true);
  });

  it('catches the usual progress words', () => {
    expect(looksLikePartialProgress('almost there')).toBe(true);
    expect(looksLikePartialProgress('working on it')).toBe(true);
    expect(looksLikePartialProgress('50 done so far')).toBe(true);
    expect(looksLikePartialProgress('balance will be done tomorrow')).toBe(true);
    expect(looksLikePartialProgress('yet to start')).toBe(true);
  });

  it('does NOT block a plain completion', () => {
    expect(looksLikePartialProgress('Done')).toBe(false);
    expect(looksLikePartialProgress('It is completed')).toBe(false);
    expect(looksLikePartialProgress('Sent it to the CA yesterday')).toBe(false);
    expect(looksLikePartialProgress('I have uploaded all the BOMs')).toBe(false);
    expect(looksLikePartialProgress('submitted')).toBe(false);
  });

  it('a clear "all done" beats a progress word in the same message', () => {
    // "remaining" would normally block, but they have plainly said the whole thing is finished
    expect(looksLikePartialProgress('The remaining ones are done too — all done now')).toBe(false);
    expect(looksLikePartialProgress('120 of 120 uploaded, fully completed')).toBe(false);
  });

  it('a count equal to the total is not partial', () => {
    expect(looksLikePartialProgress('120 of 120')).toBe(false);
  });

  it('handles empty input', () => {
    expect(looksLikePartialProgress('')).toBe(false);
    expect(looksLikePartialProgress('   ')).toBe(false);
  });
});
