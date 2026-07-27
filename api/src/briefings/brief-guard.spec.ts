import { gradeBriefDraft, inventedTemporal, cadenceFromWords, mustKeepTerms, summaryContradicts, temporalTokens, chaseTimesFrom, DEFAULT_CHASE_TIMES } from './brief-guard';

/**
 * BEA-1151. The fixture is the owner's real briefing of 27 July, word for word, and the tasks the
 * AI actually produced from it. If this test ever passes for the wrong reason, that morning's
 * WhatsApp message to Rakesh goes out again.
 */
const RAKESH_BRIEF =
  'This is to Rakesh. So every day rakesh has to send production updates based the plan. ' +
  'He has to clearly communicate if we are going according to plan. ' +
  'He has to send updates without missing both Haasya and MIC.';

const WHAT_THE_AI_MADE = [
  { title: 'Send Monday night production status update' },
  { title: "Share the production plan at Wednesday's meeting" },
  { title: 'Send Friday night production status update' },
];

describe('the real Rakesh briefing (BEA-1151)', () => {
  it('throws out all three invented weekdays', () => {
    const g = gradeBriefDraft(RAKESH_BRIEF, WHAT_THE_AI_MADE);
    expect(g.kept).toHaveLength(0);
    expect(g.dropped.map((d) => d.invented).flat().sort()).toEqual(['friday', 'monday', 'wednesday']);
  });

  it('reads the cadence he actually said', () => {
    expect(cadenceFromWords(RAKESH_BRIEF)).toBe('daily');
  });

  it('catches the summary that turned every day into every week', () => {
    expect(summaryContradicts(RAKESH_BRIEF, 'Rakesh must send Sandeep regular production status updates every week.')).toBe(true);
    expect(summaryContradicts(RAKESH_BRIEF, 'Rakesh sends a daily production update.')).toBe(false);
  });

  it('notices Haasya and MIC were dropped', () => {
    const g = gradeBriefDraft(RAKESH_BRIEF, WHAT_THE_AI_MADE);
    expect(g.missingTerms.sort()).toEqual(['Haasya', 'MIC']);
  });

  it('keeps an honest task built from his own words', () => {
    const good = [{ title: 'Send the daily production update', note: 'Cover both Haasya and MIC, and say if we are going to plan.' }];
    const g = gradeBriefDraft(RAKESH_BRIEF, good);
    expect(g.kept).toHaveLength(1);
    expect(g.dropped).toHaveLength(0);
    expect(g.missingTerms).toHaveLength(0);
  });
});

describe('what counts as invented', () => {
  it('a weekday he never said', () => {
    expect(inventedTemporal('send it every day', 'Send it on Tuesday')).toEqual(['day:tuesday']);
  });

  it('a weekday he DID say is fine', () => {
    expect(inventedTemporal('send it every Tuesday', 'Send the Tuesday report')).toEqual([]);
    expect(inventedTemporal('send it on Tues', 'Send the Tuesday report')).toEqual([]); // same day, short form
  });

  it('a clock time he never said', () => {
    expect(inventedTemporal('send it in the evening', 'Send it by 7pm')).toEqual(['time:19:00']);
    expect(inventedTemporal('send it by 7pm', 'Send it by 7 pm')).toEqual([]);
  });

  it('a figure he never said', () => {
    expect(inventedTemporal('order the sheets', 'Order 200 sheets')).toEqual(['num:200']);
    expect(inventedTemporal('order 200 sheets', 'Order 200 sheets')).toEqual([]);
  });

  it('spelled and ordinal numbers are the same number', () => {
    expect(inventedTemporal('check the third floor', 'Check the 3rd floor')).toEqual([]);
    expect(inventedTemporal('check the 3rd floor', 'Check the third floor')).toEqual([]);
  });

  it('a month he never said', () => {
    expect(inventedTemporal('finish it soon', 'Finish it in August')).toEqual(['month:august']);
  });

  it('plain words are never treated as commitments', () => {
    expect(inventedTemporal('get the vendor list', 'Send the vendor list to Sandeep')).toEqual([]);
  });
});

describe('cadence and constraints come from his words', () => {
  it('no cadence said means no cadence guessed', () => {
    expect(cadenceFromWords('Rakesh should send the vendor list')).toBeNull();
  });

  it('reads the common ways of saying it', () => {
    expect(cadenceFromWords('everyday please')).toBe('daily');
    expect(cadenceFromWords('each day')).toBe('daily');
    expect(cadenceFromWords('once a week')).toBe('weekly');
    expect(cadenceFromWords('every month without fail')).toBe('monthly');
  });

  it('pulls out what he said not to miss', () => {
    expect(mustKeepTerms('send updates without missing both Haasya and MIC').sort()).toEqual(['Haasya', 'MIC']);
    expect(mustKeepTerms("don't miss the KIOT numbers")).toEqual(['KIOT numbers']);
    expect(mustKeepTerms('just send it over')).toEqual([]);
  });

  it('ignores filler that proves nothing', () => {
    expect(mustKeepTerms('without missing anything')).toEqual([]);
    expect(mustKeepTerms('without missing the updates')).toEqual([]);
  });

  it('reads a clock time as a time, not as a stray number', () => {
    const t = temporalTokens('send it at 7pm');
    expect(t.has('time:19:00')).toBe(true);
    expect(t.has('num:7')).toBe(false);
  });
});

/**
 * BEA-1148. The brief lane created tasks and then told him: "Set their chase times on their contact
 * page." The chase now starts itself — but the times still have to come from his words, or we are
 * straight back to BEA-1151.
 */
describe('when to chase, from his words (BEA-1148)', () => {
  it('uses a time he actually named', () => {
    expect(chaseTimesFrom('Karthik must send the Haasya production update by 7PM')).toEqual(['19:00']);
    expect(chaseTimesFrom('send it at 9:30 am')).toEqual(['09:30']);
    expect(chaseTimesFrom('updates at 11:00 and 17:30')).toEqual(['11:00', '17:30']);
  });

  it('falls back to the standard two slots when he named none', () => {
    expect(chaseTimesFrom(RAKESH_BRIEF)).toEqual(DEFAULT_CHASE_TIMES);
    expect(chaseTimesFrom('just chase him')).toEqual(DEFAULT_CHASE_TIMES);
  });

  it('never invents a time — every slot it returns is one he said', () => {
    const raw = 'send the update by 7pm';
    for (const t of chaseTimesFrom(raw)) expect(inventedTemporal(raw, `chase at ${t}`)).toEqual([]);
  });

  it('handles midnight and noon without wrapping wrongly', () => {
    expect(chaseTimesFrom('at 12pm')).toEqual(['12:00']);
    expect(chaseTimesFrom('at 12am')).toEqual(['00:00']);
  });
});
