import { wrapTitle, buildTitleCardSvg, extractOwnOgImage, escapeXml, svgToPng, cardLayout } from './documents-og';

describe('documents-og (BEA-900)', () => {
  it('wraps a title into at most 3 lines, ellipsising overflow', () => {
    expect(wrapTitle('Short one')).toEqual(['Short one']);
    const long = wrapTitle('The complete reference and cost model for a read-only multi-tenant RAG chat system built for scale');
    expect(long.length).toBeLessThanOrEqual(3);
    expect(long[long.length - 1]).toMatch(/…$/); // overflowed → ellipsis
  });

  it('builds an SVG that carries the (escaped) title and a kind label', () => {
    const svg = buildTitleCardSvg({ title: 'Tom & Jerry <notes>', kind: 'html' });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Tom &amp; Jerry &lt;notes&gt;');
    expect(svg).toContain('WEB PAGE'); // html → "Web page", drawn as the eyebrow above the title
    expect(svg).toContain('mybrain.1site.ai');
  });

  it('takes an explicit type label for things that are not documents (BEA-1135)', () => {
    expect(buildTitleCardSvg({ title: 'Start a new app', label: 'Skill' })).toContain('SKILL');
    expect(buildTitleCardSvg({ title: 'Board call', label: 'Meeting' })).toContain('MEETING');
    // the label wins over the document kind
    expect(buildTitleCardSvg({ title: 'x', kind: 'pdf', label: 'Bookmark' })).toContain('BOOKMARK');
  });

  it('keeps the type label clear of the brand mark AND of the title, at every title length', () => {
    const BRAND_BOTTOM = 126; // the "MY BRAIN" row occupies y 86–126
    for (const lineCount of [1, 2, 3]) {
      const { fs, lh, startY, eyebrowY } = cardLayout(lineCount);
      expect(eyebrowY).toBeGreaterThan(BRAND_BOTTOM + 28); // label sits below the brand row
      expect(startY - fs).toBeGreaterThanOrEqual(eyebrowY + 20); // title top never rides into the label
      expect(startY + (lineCount - 1) * lh + 20).toBeLessThan(500); // last line stays above the divider
    }
  });

  it('renders a long title and an &-containing title without breaking the SVG', () => {
    const long = buildTitleCardSvg({ title: 'A really very long shared title that will not fit on one single line at all', label: 'Skill' });
    expect(svgToPng(long).length).toBeGreaterThan(1000);
    expect(svgToPng(buildTitleCardSvg({ title: 'Tom & Jerry', label: 'Skill' })).length).toBeGreaterThan(1000);
  });

  it('renders the card SVG to a non-trivial PNG', () => {
    const png = svgToPng(buildTitleCardSvg({ title: 'A test document', kind: 'md' }));
    expect(png.length).toBeGreaterThan(1000);
    expect(png.slice(1, 4).toString()).toBe('PNG'); // PNG signature
  });

  it('extracts an author-supplied og:image from HTML (both attribute orders)', () => {
    expect(extractOwnOgImage('<meta property="og:image" content="https://x.com/a.png">')).toBe('https://x.com/a.png');
    expect(extractOwnOgImage('<meta content="https://x.com/b.jpg" property="og:image" />')).toBe('https://x.com/b.jpg');
    expect(extractOwnOgImage('<meta property="og:image" content="/relative.png">')).toBeNull(); // not absolute
    expect(extractOwnOgImage('<p>no meta here</p>')).toBeNull();
  });

  it('escapes XML special chars', () => {
    expect(escapeXml('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
  });
});
