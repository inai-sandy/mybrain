import { clampTitle } from './clamp-title';

/**
 * BEA-1269: the Home card printed "…then send it back to all three sa" — a blunt `.slice(0, 160)`
 * cut the generated title inside a word. A shortened title has to read like a shortened sentence,
 * not like a broken one, so the cut lands on a word boundary and says that it happened.
 */
describe('clampTitle — shortening a generated title without breaking a word', () => {
  it('leaves a title that already fits exactly as it is', () => {
    expect(clampTitle('Send Radha the production status')).toBe('Send Radha the production status');
  });

  it('adds no ellipsis to a title sitting right on the limit', () => {
    const exact = 'x'.repeat(160);
    expect(clampTitle(exact)).toBe(exact);
  });

  it('never cuts inside a word — the real BEA-1269 sentence', () => {
    const real =
      'When I sync with Deepthi and Anil after lunch this week, list the three biggest Beakn blockers and ask each for a commit date, then send it back to all three same day';
    const out = clampTitle(real);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\ssa…$/); // the exact break that was shipped
    // whatever survived is made of whole words from the original
    expect(real.startsWith(out.slice(0, -1))).toBe(true);
  });

  it('never returns more characters than the limit, ellipsis included', () => {
    const out = clampTitle('word '.repeat(80), 40);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  it('drops trailing punctuation so the join does not read as a typo', () => {
    expect(clampTitle('Ask each person for a commit date, then chase them', 34)).toBe('Ask each person for a commit date…');
  });

  it('falls back to a hard cut when the first word is longer than the budget', () => {
    const out = clampTitle('https://example.com/' + 'a'.repeat(300), 40);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.length).toBeGreaterThan(1); // not just an ellipsis
  });

  it('collapses whitespace so a multi-line answer becomes one clean title', () => {
    expect(clampTitle('  Send   the\n\nstatus  ')).toBe('Send the status');
  });

  it('treats null and undefined as empty rather than printing them', () => {
    expect(clampTitle(null)).toBe('');
    expect(clampTitle(undefined)).toBe('');
  });

  it('never cuts an emoji in half', () => {
    // An odd budget over astral-plane characters used to split a surrogate pair and leave a
    // broken glyph sitting right before the ellipsis.
    for (const max of [9, 10, 11, 12, 13]) {
      const out = clampTitle('😀'.repeat(50), max);
      expect(out).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
      expect(out).not.toContain('�');
      expect([...out].length).toBeLessThanOrEqual(max);
    }
  });

  it('counts an emoji as one character, so the limit means characters not code units', () => {
    expect(clampTitle('😀'.repeat(5))).toBe('😀'.repeat(5)); // well under 160 characters
  });

  it('leaves punctuation alone on a title that fits — only a cut earns the tidy-up', () => {
    // The telegram reminder path strips its own trailing commas before calling in; this helper
    // must not silently reword a title it did not shorten.
    expect(clampTitle('Call John,')).toBe('Call John,');
  });
});
