import { Resvg } from '@resvg/resvg-js';

/** Link-preview (Open Graph) helpers for shared documents (BEA-900). Generates a clean TITLE CARD
 *  — the document title + a My Brain brand mark on a branded background. No AI art. */

export function escapeXml(s: string): string {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

/** Greedy word-wrap into at most `maxLines` lines of ~`max` chars; ellipsis if it overflows. */
export function wrapTitle(title: string, max = 26, maxLines = 3): string[] {
  const words = String(title || 'Untitled').trim().split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; if (lines.length === maxLines) break; }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines) {
    const used = lines.join(' ').split(/\s+/).length;
    if (used < words.length) lines[maxLines - 1] = lines[maxLines - 1].replace(/\.*$/, '') + '…';
  }
  return lines.slice(0, maxLines);
}

const KIND_LABEL: Record<string, string> = { md: 'Document', html: 'Web page', site: 'Web page', pdf: 'PDF', image: 'Image', other: 'Document' };

/** Where the type label and the title block sit, for a title of `lineCount` lines.
 *  The eyebrow is fixed just below the brand row; the title is centred BUT pushed down when a tall
 *  (2–3 line) title would otherwise ride up into the eyebrow and the brand mark. */
export function cardLayout(lineCount: number): { fs: number; lh: number; startY: number; eyebrowY: number } {
  const fs = lineCount >= 3 ? 66 : lineCount === 2 ? 74 : 82;
  const lh = Math.round(fs * 1.18);
  const eyebrowY = 200;
  const centred = 300 - (lineCount * lh) / 2 + fs; // baseline of the first line if perfectly centred
  const startY = Math.max(centred, eyebrowY + 40 + fs); // never overlap the eyebrow
  return { fs, lh, startY, eyebrowY };
}

/** Build the 1200×630 title-card SVG.
 *  `label` names the KIND of thing being shared (Skill, Meeting, Bookmark…) and is drawn as a small
 *  eyebrow above the title. `kind` is the document-specific shorthand kept for existing callers. */
export function buildTitleCardSvg(opts: { title: string; kind?: string; label?: string }): string {
  const lines = wrapTitle(opts.title);
  const { fs, lh, startY, eyebrowY } = cardLayout(lines.length);
  const tspans = lines.map((l, i) => `<text x="90" y="${startY + i * lh}" fill="#f2f4f8" font-family="'DejaVu Sans',Arial,sans-serif" font-size="${fs}" font-weight="800" letter-spacing="-1">${escapeXml(l)}</text>`).join('');
  const kind = (opts.label || KIND_LABEL[opts.kind || 'md'] || 'Document').toUpperCase();
  // Eyebrow: the type, directly above the title block, so a shared card reads as what it is.
  const eyebrow = `<text x="90" y="${eyebrowY}" fill="#34d399" font-family="'DejaVu Sans',Arial,sans-serif" font-size="28" font-weight="700" letter-spacing="5">${escapeXml(kind)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="18%" cy="12%" r="75%">
      <stop offset="0%" stop-color="#0f2a20"/><stop offset="55%" stop-color="#0a1016"/><stop offset="100%" stop-color="#07090f"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="1200" height="6" fill="#34d399"/>
  <g transform="translate(90,86)">
    <rect x="0" y="0" width="40" height="40" rx="11" fill="#34d399"/>
    <text x="56" y="29" fill="#aeb4c2" font-family="'DejaVu Sans',Arial,sans-serif" font-size="24" font-weight="700" letter-spacing="4">MY BRAIN</text>
  </g>
  ${eyebrow}
  ${tspans}
  <line x1="90" y1="500" x2="1110" y2="500" stroke="#20232e" stroke-width="2"/>
  <text x="1110" y="548" text-anchor="end" fill="#34d399" font-family="'DejaVu Sans',Arial,sans-serif" font-size="26" font-weight="700">mybrain.1site.ai</text>
</svg>`;
}

/** Render an SVG to a PNG Buffer (1200×630). Throws on failure — callers fall back to the static card. */
export function svgToPng(svg: string): Buffer {
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng());
}

/** Pull an author-supplied absolute og:image URL out of an HTML document, if any. */
export function extractOwnOgImage(html: string): string | null {
  const s = String(html || '');
  const a = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(s);
  const b = a || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(s);
  const url = b?.[1]?.trim();
  return url && /^https?:\/\//i.test(url) ? url : null;
}
