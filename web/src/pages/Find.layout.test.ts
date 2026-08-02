import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * BEA-1271: /explore rendered its content column 625px wide inside a 390px phone, so ~40% of the
 * page was invisible (the page does not scroll sideways). The cause is a CSS rule jsdom cannot
 * reproduce — it has no layout engine — so this guards the source instead.
 *
 * The rule: a grid item defaults to `min-width: auto`, meaning it will not shrink below its own
 * content. The "you asked before" chips use `truncate` (`white-space: nowrap`), whose min-content
 * width is the whole untruncated question. `max-w-full` on a chip cannot save it, because the
 * parent's width is what is being computed. `min-w-0` breaks the cycle.
 *
 * Verified in the live browser: adding min-width:0 to these two columns took the count of elements
 * overflowing a 390px viewport from 58 to 0, and the column from 625px to 343px.
 */
// vitest runs with the web/ package as its working directory.
const SRC = readFileSync('src/pages/Find.tsx', 'utf8');

describe('Explore — the columns must be allowed to shrink on a phone', () => {
  it('every column of the lg:grid-cols-5 row carries min-w-0', () => {
    // There is exactly one such grid in this file, and `lg:col-span-*` is used nowhere else, so
    // matching any span across the whole file catches a column added later too — pinning the exact
    // spans (2 and 3) would let a third, unguarded column slip through while the test still passed.
    expect(SRC.match(/lg:grid-cols-5/g)?.length).toBe(1);

    const cols = [...SRC.matchAll(/className="([^"]*\blg:col-span-\d+[^"]*)"/g)].map((m) => m[1]);
    expect(cols.length).toBeGreaterThanOrEqual(2);

    for (const cls of cols) {
      expect(cls.split(/\s+/)).toContain('min-w-0');
    }
  });

  it('the chips that caused it still truncate rather than wrap the layout open', () => {
    // If these lose `truncate` the bug changes shape rather than disappearing, so pin it.
    expect(SRC).toContain('max-w-full truncate');
  });
});
