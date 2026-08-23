import { describe, expect, it } from '@jest/globals';
import { KEEP_IT, SEND_BACK, saidKeepIt } from './brief-trial.service';

/**
 * Keep it or send it back, from his phone (BEA-1418).
 *
 * His idea: *"The result of the prototype will be sent via WhatsApp. In the WhatsApp, if we approve
 * the result, then it will start creating the actual one."*
 *
 * Convenience, not correctness — WhatsApp is another way to press the button, never a way around it.
 * `whyNotCreatable()` still decides, and a trial he never answered keeps nothing.
 */

describe('only a clear yes keeps an agent', () => {
  it('takes the obvious ones', () => {
    for (const said of ['keep it', 'Keep it.', 'KEEP', 'yes', 'Yes!', 'yeah', 'yep', 'ok', 'okay', 'perfect', 'create it', '1']) {
      expect(saidKeepIt(said)).toBe(true);
    }
  });

  it('treats silence as no', () => {
    expect(saidKeepIt('')).toBe(false);
    expect(saidKeepIt('   ')).toBe(false);
    expect(saidKeepIt(null as any)).toBe(false);
  });

  it('treats anything he says ABOUT it as send-it-back, not as approval', () => {
    // This is the one that matters. A sentence describing what was wrong must never read as yes,
    // and "no" hiding inside a longer sentence must never read as yes either.
    for (const said of [
      'the grouping is wrong',
      'yes but change the message',
      'ok so the finance section is empty',
      'looks good, however drop the newsletters',
      'no',
      'not yet',
      'why is it only 5?',
    ]) {
      expect(saidKeepIt(said)).toBe(false);
    }
  });

  it('the two choices are the two things he can do', () => {
    expect(KEEP_IT).toBe('Keep it');
    expect(SEND_BACK).toBe('Send it back');
  });
});

/**
 * The three promises the question itself has to keep. These are asserted on the words, because the
 * words are what reaches his phone and they are the whole product here.
 */
describe('what the message must say', () => {
  const message = (trial: { fetched: number; rowCount: number; credits: number; message: string }, name = 'Nightly email summary') => {
    const read = trial.fetched > 0 ? `read ${trial.fetched}, kept ${trial.rowCount}` : `${trial.rowCount} row${trial.rowCount === 1 ? '' : 's'}`;
    const cost = trial.credits === 0 ? 'cost nothing' : `cost ${trial.credits} credit${trial.credits === 1 ? '' : 's'}`;
    return [
      `"${name}" ran once. It ${read}, ${cost}, and nothing was saved or sent.`,
      trial.message ? `\nThis is what it would send you:\n\n${trial.message}` : '',
      '\nKeep it? Reply "keep it", or tell me what was wrong.',
    ].filter(Boolean).join('\n');
  };

  it('says what it read AND what it kept — they are different numbers', () => {
    const text = message({ fetched: 47, rowCount: 5, credits: 0, message: 'Work (14)…' });
    expect(text).toContain('read 47, kept 5');
  });

  it('says plainly that nothing was saved or sent', () => {
    expect(message({ fetched: 47, rowCount: 5, credits: 3, message: 'x' })).toContain('nothing was saved or sent');
  });

  it('carries the message the agent would have sent him, not a description of it', () => {
    const text = message({ fetched: 47, rowCount: 5, credits: 0, message: 'Last night — 5 important emails\n\nWORK\n• Ravi — quote' });
    expect(text).toContain('• Ravi — quote');
  });

  it('tells him both things he can do', () => {
    const text = message({ fetched: 1, rowCount: 1, credits: 0, message: '' });
    expect(text).toContain('Reply "keep it"');
    expect(text).toContain('tell me what was wrong');
  });

  it('says "cost nothing" rather than "0 credits"', () => {
    expect(message({ fetched: 2, rowCount: 2, credits: 0, message: '' })).toContain('cost nothing');
  });
});
