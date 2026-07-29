import { cacheDecision, storyFingerprint } from './mine-cache';

/**
 * BEA-1164. The deep read cost ~30 seconds and a paid call, and lived only in the browser's memory —
 * so a reload threw it away and charged him again. On 28 July it ran SIX times for one day.
 *
 * His rule, in his words: *"it should not run api calls repeatedly."*
 */
describe('storyFingerprint', () => {
  it('is the same story after re-wrapping lines or a stray double space', () => {
    expect(storyFingerprint('Went to the factory.\nFixed the QC sheet.')).toBe(storyFingerprint('Went to the  factory. Fixed the QC sheet.'));
  });

  it('changes when he actually rewrites something', () => {
    expect(storyFingerprint('Called Rakesh about the PCB')).not.toBe(storyFingerprint('Called Radha about the PCB'));
  });

  it('an empty story does not collide with a real one', () => {
    expect(storyFingerprint('')).not.toBe(storyFingerprint('a real day'));
  });
});

describe('cacheDecision — never spend a call the app was not asked for', () => {
  const stored = JSON.stringify({ done: [{ title: 'Called the CA' }], todos: [] });
  const text = 'A full day at the factory.';
  const hash = storyFingerprint(text);

  it('uses the stored reading when the story has not moved', () => {
    const d = cacheDecision({ stored, storedHash: hash, currentText: text });
    expect(d.use).toBe('cached');
    expect((d as any).stale).toBe(false);
    expect((d as any).payload.done[0].title).toBe('Called the CA');
  });

  it('STILL uses it when the story was edited — flagged stale, not re-run', () => {
    const d = cacheDecision({ stored, storedHash: hash, currentText: text + ' Then the EMO test.' });
    expect(d.use).toBe('cached'); // the app never decides on its own to spend another call
    expect((d as any).stale).toBe(true);
  });

  it('reads afresh only when HE asks — the "Read it again" button', () => {
    expect(cacheDecision({ stored, storedHash: hash, currentText: text, force: true }).use).toBe('fresh');
  });

  it('reads afresh when there is nothing stored', () => {
    expect(cacheDecision({ stored: null, storedHash: null, currentText: text }).use).toBe('fresh');
  });

  it('does not serve a stored FAILURE — that would trap him on a bad read forever', () => {
    const bad = JSON.stringify({ failed: true, done: [] });
    expect(cacheDecision({ stored: bad, storedHash: hash, currentText: text }).use).toBe('fresh');
  });

  it('a corrupt cache is no cache', () => {
    expect(cacheDecision({ stored: '{not json', storedHash: hash, currentText: text }).use).toBe('fresh');
    expect(cacheDecision({ stored: '"a string"', storedHash: hash, currentText: text }).use).toBe('fresh');
  });
});
