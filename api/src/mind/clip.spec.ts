import { clip } from './chain.service';

/**
 * BEA-1137: a raw slice(0,200) stored the situation lever cut mid-word, so the dashboard showed
 * "…send it back to all three same d". Text that reaches the owner must end on a whole word.
 */
describe('clip — never cut a word in half', () => {
  it('leaves short text alone', () => {
    expect(clip('short enough', 200)).toBe('short enough');
  });

  it('cuts on a word boundary and marks it', () => {
    const out = clip('alpha beta gamma delta epsilon', 20);
    expect(out.endsWith('…')).toBe(true);
    // every kept word must be a whole word from the original
    const words = out.replace('…', '').trim().split(' ');
    for (const w of words) expect('alpha beta gamma delta epsilon'.split(' ')).toContain(w);
  });

  it('reproduces the real failure — the owner\'s lever no longer ends mid-word', () => {
    const real = 'When you next sync with Deepthi and Anil (after lunch this week), I\'ll list the three biggest blockers and ask each person for their commit date—then write it down and send it back to all three same day so nobody can quietly drop it.';
    const out = clip(real, 200);
    expect(out.endsWith('same d')).toBe(false);
    expect(out.endsWith('…')).toBe(true);
  });

  it('does not leave dangling punctuation before the ellipsis', () => {
    expect(clip('one two three, four five six seven', 14)).not.toMatch(/[,;:.\s]…$/);
  });

  it('handles empty input', () => {
    expect(clip('', 200)).toBe('');
  });
});
