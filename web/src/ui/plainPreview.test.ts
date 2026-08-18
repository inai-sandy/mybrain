import { describe, expect, it } from 'vitest';
import { plainPreview } from './plainPreview';

/** BEA-1363: one-line run previews are plain text — no markdown markers, no table rows. */
describe('plainPreview', () => {
  it('strips bold and italic markers from a Watch job answer (the acceptance case)', () => {
    expect(plainPreview('**Nothing changed since 18 Aug, 03:31.**  _1 credit_')).toBe('Nothing changed since 18 Aug, 03:31. 1 credit');
  });

  it('shows the sentence before a markdown table, never the table', () => {
    const md = '**followers 47,612 → 47,650** (+38).\n\n| what | before | now |\n|---|---|---|\n| followers | 47,612 | 47,650 |\n';
    const out = plainPreview(md);
    expect(out).toBe('followers 47,612 → 47,650 (+38).');
    expect(out).not.toContain('|');
  });

  it('drops headings, backticks, quotes, bullets, rules and turns links into their text', () => {
    const md = '# Daily brief\n\n> Note\n\n- `three` new [items](https://x.y/z) landed\n- one __more__\n\n---\n\n![img](a.png)';
    expect(plainPreview(md)).toBe('Daily brief Note three new items landed one more');
  });

  it('collapses whitespace and returns nothing for nothing', () => {
    expect(plainPreview('  a  \n\n\n  b ')).toBe('a b');
    expect(plainPreview('')).toBe('');
    expect(plainPreview(null)).toBe('');
    expect(plainPreview(undefined)).toBe('');
  });

  it('keeps whole sentences up to max, and cuts a long one on a word', () => {
    const md = 'First one. Second one is here. Third one goes on and on.';
    expect(plainPreview(md, 30)).toBe('First one. Second one is here.');
    const long = 'word '.repeat(60).trim();
    const cut = plainPreview(long, 40);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(41);
  });

  it('leaves ordinary text alone (numbers, snake_case words, arrows)', () => {
    expect(plainPreview('followers 47,650 → 47,700 in 2 days')).toBe('followers 47,650 → 47,700 in 2 days');
    expect(plainPreview('run_id stays run_id')).toBe('run_id stays run_id');
  });

  it('only strips list numbers, bullets and rules at a line start — never mid-sentence (review)', () => {
    expect(plainPreview('We reached step 2. Also a new record today')).toBe('We reached step 2. Also a new record today');
    expect(plainPreview('Version 3) is out now')).toBe('Version 3) is out now');
    expect(plainPreview('5 * 3 = 15')).toBe('5 * 3 = 15');
    expect(plainPreview('--dry-run: does nothing\n1. first\n2) second')).toBe('--dry-run: does nothing first second');
    expect(plainPreview('| a | b |\n|---|:--:|\n---|---\nAfter the table.')).toBe('After the table.');
  });
});
