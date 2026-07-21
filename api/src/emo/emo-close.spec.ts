import { titleScore } from './emo-close.service';

/**
 * "finish the BOM" is a new task; "finished the BOM" is a close. Getting that wrong creates a
 * duplicate AND leaves the real one open, still being chased. The matcher must be confident or
 * ask — never guess. (BEA-1033)
 */
describe('titleScore — matching what was said to a real task (BEA-1033)', () => {
  it('scores an obvious match highly', () => {
    expect(titleScore('Ramesh finished the GST filing', 'Finish the GST filing')).toBeGreaterThanOrEqual(0.5);
  });

  it('ignores the words that describe the ACT rather than the work', () => {
    const a = titleScore('the vendor list is done', 'Send the vendor list');
    const b = titleScore('vendor list', 'Send the vendor list');
    expect(a).toBeGreaterThanOrEqual(0.5);
    expect(Math.abs(a - b)).toBeLessThan(0.35); // "is done" adds no signal either way
  });

  it('scores an unrelated task near zero', () => {
    expect(titleScore('Ramesh finished the GST filing', 'Book flights to Chennai')).toBe(0);
  });

  it('does not let a person’s name alone carry a match', () => {
    expect(titleScore('Ramesh finished it', 'Ramesh should send the drawings')).toBeLessThan(0.5);
  });

  it('is not fooled by short filler words', () => {
    expect(titleScore('it is done', 'Send the signed agreement')).toBe(0);
  });

  it('handles empty input without throwing', () => {
    expect(titleScore('', 'anything')).toBe(0);
    expect(titleScore('anything', '')).toBe(0);
    expect(titleScore(undefined as any, undefined as any)).toBe(0);
  });

  it('two similar tasks score close together — which is what forces the "which one?" question', () => {
    const said = 'the payment discussion is done';
    const a = titleScore(said, 'Discuss pending payments with Srikar');
    const b = titleScore(said, 'Discuss pending incoming payments with Srikar');
    expect(Math.abs(a - b)).toBeLessThan(0.2);
  });
});
