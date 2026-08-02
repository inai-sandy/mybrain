import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * BEA-1272: the documents toolbar was one non-wrapping flex row. On a 390px phone the tag filter
 * (112px), sort (108px), starred toggle (34px) and view toggle (60px) plus gaps used ~330px of the
 * 343px available, so the search wrapper — `flex-1 min-w-0` — was squeezed to **zero width**. Its
 * `w-full` input then painted outside its own collapsed parent, 74px wide, sitting underneath the
 * tag `<select>`. It rendered as a stub showing a truncated "s".
 *
 * jsdom has no layout engine, so it cannot reproduce a flex squeeze. This guards the source rule.
 * Verified in the live browser: with the row wrapping and the search on its own line, the search
 * wrapper went 0px → 343px and overlapping control pairs went to 0.
 */
// vitest runs with the web/ package as its working directory.
const SRC = readFileSync('src/pages/Documents.tsx', 'utf8');

describe('Documents toolbar — the search box must survive a phone', () => {
  const row = SRC.slice(SRC.indexOf('Unified controls row'), SRC.indexOf('Search documents…'));

  it('the controls row is allowed to wrap', () => {
    expect(row).toContain('flex-wrap');
  });

  it('the search box claims a full line of its own before sm:', () => {
    // `flex-1` alone is what let it be squeezed to nothing — it needs a definite basis on phones.
    const wrapper = row.match(/className="(relative[^"]*)"/)?.[1] || '';
    expect(wrapper).toContain('basis-full');
    expect(wrapper.split(/\s+/)).toContain('min-w-0');
    // ...and it must go back to sharing the row from sm: up, as it did before.
    expect(wrapper).toMatch(/sm:(flex-1|basis-auto)/);
  });

  it('the search input still fills its wrapper', () => {
    expect(SRC).toMatch(/placeholder="Search documents…"[^>]*className="w-full/);
  });
});
