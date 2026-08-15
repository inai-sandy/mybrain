import { buildRadarCardSvg, clipHeadline } from './radar-card';

/**
 * BEA-1326 — the live share-card image for the public /radar page.
 *
 * The promises: today's hot headlines are drawn (escaped, clipped to one line each),
 * an empty day falls back to the tagline instead of a blank card, and the card always
 * carries the brand, the date and the page's address.
 */

describe('the /radar share-card image (BEA-1326)', () => {
  it('draws up to three numbered hot headlines', () => {
    const svg = buildRadarCardSvg({ date: 'Friday, 15 August 2026', headlines: ['One story', 'Two story', 'Three story', 'Four story'] });
    expect(svg).toContain('>One story<');
    expect(svg).toContain('>Three story<');
    expect(svg).not.toContain('Four story');
    expect(svg).toContain('#1');
    expect(svg).toContain('#3');
    expect(svg).toContain('HOT NOW');
  });

  it('escapes XML in a headline — ampersands and tags come from real feeds', () => {
    const svg = buildRadarCardSvg({ date: 'D', headlines: ['Q&A <script> tricks'] });
    expect(svg).toContain('Q&amp;A &lt;script&gt; tricks');
    expect(svg).not.toContain('<script>');
  });

  it('clips a long headline to one clean line', () => {
    const long = 'Google will now allow users to remove visible watermark from its AI generations entirely';
    expect(clipHeadline(long).length).toBeLessThanOrEqual(48);
    expect(clipHeadline(long).endsWith('…')).toBe(true);
    expect(clipHeadline('short')).toBe('short');
  });

  it('an empty day gets the tagline, never a blank card', () => {
    const svg = buildRadarCardSvg({ date: 'D', headlines: [] });
    expect(svg).toContain('AI news from around the world,');
    expect(svg).not.toContain('HOT NOW');
  });

  it('always carries the brand, the date and the page address', () => {
    const svg = buildRadarCardSvg({ date: 'Friday, 15 August 2026', headlines: ['X'] });
    expect(svg).toContain('MY BRAIN');
    expect(svg).toContain('AI NEWS DAILY');
    expect(svg).toContain('Friday, 15 August 2026');
    expect(svg).toContain('mybrain.1site.ai/radar');
    expect(svg).toContain('width="1200" height="630"');
  });
});
