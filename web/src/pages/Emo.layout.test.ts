import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * BEA-1273: nothing on /emo overflowed, but at 390px it read as unfinished — the dictation prompt
 * was cut mid-sentence behind an inner scrollbar, the title was squeezed into a narrow column
 * beside the Ask/Record buttons, and the card search was stranded alone on its own line.
 *
 * jsdom has no layout engine, so it cannot see a squeezed column or a clipped textarea. These guard
 * the source rules instead. Measured live: the prompt needs 96px at 390px wide but a 2-row box
 * gives 58px; raising the min-height to 6.5rem (104px) clears it.
 */
// vitest runs with the web/ package as its working directory.
const SRC = readFileSync('src/pages/Emo.tsx', 'utf8');

describe('Emo — must not feel cramped on a phone', () => {
  it('the title stacks above the Ask/Record buttons on phones', () => {
    const header = SRC.slice(SRC.indexOf('<h1 className="text-xl font-bold">Emo</h1>') - 400, SRC.indexOf('<h1 className="text-xl font-bold">Emo</h1>'));
    const row = header.match(/className="(flex[^"]*)"/g)?.pop() || '';
    expect(row).toContain('flex-col'); // stacked by default...
    expect(row).toContain('sm:flex-row'); // ...back to one row from sm: up, as it was
  });

  it('the dictation box is tall enough on phones to show the whole prompt', () => {
    // Slice to the end of the <textarea> element rather than a fixed number of characters — a
    // character budget silently stops matching the moment someone lengthens a comment above it.
    const from = SRC.indexOf('placeholder="Hold the mic');
    const ta = SRC.slice(from, SRC.indexOf('/>', from));
    const cls = ta.match(/className="([^"]*min-h-[^"]*)"/)?.[1] || '';
    expect(cls).not.toBe('');

    const phone = cls.match(/(?:^|\s)min-h-\[([\d.]+)rem\]/)?.[1];
    const desktop = cls.match(/sm:min-h-\[([\d.]+)rem\]/)?.[1];
    expect(phone).toBeDefined();
    expect(desktop).toBeDefined();

    // The worst case is the NARROWEST phone, not the one in the bug report: measured on the live
    // app the prompt needs 96px at 390px but 116px at 320px, where the box is only 199px wide and
    // the text runs to five lines. 1rem = 16px.
    expect(Number(phone) * 16).toBeGreaterThanOrEqual(116);
    // ...and desktop must not have been made taller along with it.
    expect(Number(desktop)).toBeLessThan(Number(phone));
  });

  it('the card search shares the filter row instead of being stranded on its own line', () => {
    const wrap = SRC.slice(SRC.indexOf('placeholder="Search cards"') - 400, SRC.indexOf('placeholder="Search cards"'));
    const cls = wrap.match(/className="(relative[^"]*)"/)?.[1] || '';
    expect(cls).toContain('flex-1'); // takes the space left on the row...
    expect(cls.split(/\s+/)).not.toContain('ml-auto'); // ...instead of being pushed to the far end
    expect(cls).toContain('sm:ml-auto'); // desktop keeps the right-aligned placement it had
  });

  it('the card search stays legible on the narrowest phone', () => {
    // At 320px the two selects leave only ~100px on that line, which rendered the search box ~48px
    // wide — the placeholder showed as "Se". A minimum width makes it wrap to its own line instead
    // of shrinking into nonsense, while still sharing the row at 390px where there is room.
    const wrap = SRC.slice(SRC.indexOf('placeholder="Search cards"') - 400, SRC.indexOf('placeholder="Search cards"'));
    const cls = wrap.match(/className="(relative[^"]*)"/)?.[1] || '';
    const min = cls.match(/(?:^|\s)min-w-\[([\d.]+)rem\]/)?.[1];
    expect(min).toBeDefined();
    expect(Number(min) * 16).toBeGreaterThanOrEqual(120);
    expect(cls).toContain('sm:min-w-0'); // desktop is unconstrained, as before
  });

  it('the card search input fills its wrapper on phones and keeps its fixed desktop width', () => {
    const input = SRC.slice(SRC.indexOf('placeholder="Search cards"'), SRC.indexOf('placeholder="Search cards"') + 400);
    const cls = input.match(/className="([^"]*)"/)?.[1] || '';
    expect(cls.split(/\s+/)).toContain('w-full');
    expect(cls).toContain('sm:w-44');
  });
});
