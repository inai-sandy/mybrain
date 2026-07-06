import { wrapTitle, buildTitleCardSvg, extractOwnOgImage, escapeXml, svgToPng } from './documents-og';

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
    expect(svg).toContain('Web page'); // html → "Web page"
    expect(svg).toContain('mybrain.1site.ai');
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
