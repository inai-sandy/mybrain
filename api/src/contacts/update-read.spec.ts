import { readUpdate, readLabel } from './update-read';

/**
 * BEA-1159. Every message here is a real one from the owner's team. The one that matters most is
 * Radha's: two blockers that the app filed as a green tick because she never used the word "help".
 */
describe('reading what the team actually said (BEA-1159)', () => {
  const RADHA = "1. We didn't receive sense PCB for 4M - 4 Switch 1Socket \n2. ESP Add on PCB for magnetic touch was pending ( last week 2000 PCB was completed )";

  it("catches Radha's blockers, which the old signal missed entirely", () => {
    const r = readUpdate(RADHA, { isReport: true });
    expect(r.needsYou).toBe(true);
    expect(r.reads).toContain('needs_you');
  });

  it('and still counts her message as the report she owed — both are true', () => {
    // Forcing this into one bucket is exactly what turned two blockers into a tick.
    expect(readUpdate(RADHA, { isReport: true }).reads).toContain('status');
  });

  it('reads a plain report with figures as a report and nothing more', () => {
    const r = readUpdate('In Production: Magnetic touch PCB. In QC: coral PCB. 2000 completed.', { isReport: true });
    expect(r.reads).toEqual(['status']);
    expect(r.needsYou).toBe(false);
  });

  it('"Kk sir" clears nothing and asks for nothing', () => {
    for (const s of ['Kk sir', 'ok', 'Noted', 'thanks 👍', 'yes']) {
      const r = readUpdate(s, { isReport: true });
      expect(r.reads).toEqual(['chat']);
      expect(r.needsYou).toBe(false);
    }
  });

  it('a claim of done needs his yes/no', () => {
    const r = readUpdate('Task 1 all finished');
    expect(r.reads).toContain('done');
    expect(r.needsYou).toBe(true);
  });

  it('a promise is a promise, never a completion', () => {
    const r = readUpdate('Update sheet sending 12 clock', { isReport: true });
    expect(r.reads).toContain('promise');
    expect(r.reads).not.toContain('done');
    expect(r.reads).not.toContain('status');
  });

  it("Deepthi's mixed reply is read as both", () => {
    const r = readUpdate('Task 1 all finished\nTask 2 some changes in pcb ordering');
    expect(r.reads).toContain('done');
  });
});

describe('the ways his team says they are stuck', () => {
  const stuck = [
    'We have not received the material yet',
    'still pending from the vendor',
    'waiting for approval',
    'PCB order is delayed',
    'there is an issue with the socket pins',
    'not able to complete the testing',
    'we are short of 200 units',
    'I need your approval for the payment',
    'cannot proceed without the drawing',
    'Who will handle the installation?',
    'Shall I go ahead with the order',
  ];
  it.each(stuck)('reads "%s" as needing him', (s) => {
    expect(readUpdate(s).needsYou).toBe(true);
  });

  const fine = ['Sent the sheet at 11', 'All 45 BOMs uploaded today', 'Meeting done with the captains'];
  it.each(fine)('does not flag "%s"', (s) => {
    expect(readUpdate(s, { isReport: true }).reads).not.toContain('needs_you');
  });
});

describe('why it reached him, in plain words', () => {
  it('says what happened', () => {
    expect(readLabel(['needs_you', 'done'])).toBe('says it is done, and raised something');
    expect(readLabel(['needs_you'])).toBe('raised a problem');
    expect(readLabel(['done'])).toBe('says it is done');
    expect(readLabel(['status'])).toBe('sent an update');
  });
});

/**
 * A judgement call worth pinning: in a long production report, a completion word is attached to a
 * figure ("2000 completed") and is not a claim that the job is finished. Reading it as one would
 * put a routine evening report in front of him for a yes/no every single day.
 */
describe('a quantity is not a claim', () => {
  it('"2000 completed" inside a report is a report, not a done-claim', () => {
    const r = readUpdate('In Production: Magnetic touch PCB. In QC: coral PCB. 2000 completed.', { isReport: true });
    expect(r.reads).toEqual(['status']);
  });

  it('but a short message saying it is finished still is one', () => {
    expect(readUpdate('It is completed', { isReport: true }).reads).toContain('done');
    expect(readUpdate('Done', { isReport: true }).reads).toContain('done');
  });

  it('and a claim outside a standing report is untouched', () => {
    expect(readUpdate('All 120 BOMs uploaded into the system and completed the verification').reads).toContain('done');
  });
});

/**
 * BEA-1211: the review queue was rebuilt on this reader WITHOUT the BEA-1122 progress guard, so
 * "started, working on it" — a done-word inside a progress report — demanded a yes/no in review
 * all over again. The guard now lives here and runs on every read.
 */
describe('progress is never a done-claim (BEA-1211)', () => {
  it('a done-word inside a progress message does not land in review as done', () => {
    // Short messages on purpose: long ones are already saved by the quantity rule, so each of
    // these reaches review as a done-claim unless the progress guard stops it.
    for (const s of ['uploaded 45 so far', 'completed 45 of 120', 'dispatched 5, ongoing']) {
      const r = readUpdate(s, { isReport: true });
      expect(r.reads).not.toContain('done');
      expect(r.needsYou).toBe(false);
    }
  });

  it('"45 of 120 uploaded" is progress, not completion — the original BEA-1122 message', () => {
    const r = readUpdate('Total we have 120 BOMs to upload, upto know we uploaded 45 BOMs');
    expect(r.reads).not.toContain('done');
    expect(r.needsYou).toBe(false);
  });

  it('a clear completion still gets through the guard', () => {
    expect(readUpdate('All done, everything is uploaded').reads).toContain('done');
  });
});

/**
 * Found by running the backfill over the owner's real messages, not by guessing. Jayanth's nightly
 * OT report lists "Trinetra Problem Devices For Rework" — a device category, not trouble. Flagging
 * it would have put a routine report in his review every night, and an inbox with noise in it
 * stops being read at all.
 */
describe('a word that names a thing is not a problem', () => {
  const JAYANTH_OT = '19/07/2026 (Sunday)\n\nOT From 9:30 to 6:30\n\nTotal members - 5\n\n1 Person For Fitting LPF 4+1 v5\n2 Person For Testing Ageing\n1 Person For Trinetra Problem Devices For Rework\n1 Person For QC';

  it("does not flag Jayanth's OT report", () => {
    const r = readUpdate(JAYANTH_OT, { isReport: true });
    expect(r.reads).not.toContain('needs_you');
    expect(r.reads).toContain('status');
  });

  it('but still catches a real problem', () => {
    expect(readUpdate('there is a problem with the socket pins').needsYou).toBe(true);
    expect(readUpdate('Problem with the PCB order').needsYou).toBe(true);
    expect(readUpdate('facing issues in testing').needsYou).toBe(true);
  });
});
