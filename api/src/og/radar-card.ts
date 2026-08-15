import { escapeXml } from '../documents/documents-og';

/**
 * The share-card image for the public AI News Daily page (BEA-1326).
 *
 * Same 1200×630 Resvg pipeline as the document/skill cards, but indigo — the News
 * section's colour — and LIVE: it carries today's hottest headlines, so a pasted
 * /radar link previews as today's news, not as a generic logo. When nothing is hot
 * yet the card falls back to the page's own tagline; it is never blank.
 */

/** One line per story on the card; anything longer gets a clean ellipsis. */
export function clipHeadline(s: string, max = 48): string {
  const t = String(s || '').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

export function buildRadarCardSvg(opts: { date: string; headlines: string[] }): string {
  const heads = (opts.headlines || []).filter(Boolean).slice(0, 3);

  const body = heads.length
    ? heads
        .map((h, i) => {
          const y = 288 + i * 78;
          return (
            `<text x="90" y="${y}" fill="#818cf8" font-family="'DejaVu Sans',Arial,sans-serif" font-size="36" font-weight="800">#${i + 1}</text>` +
            `<text x="162" y="${y}" fill="#f2f4f8" font-family="'DejaVu Sans',Arial,sans-serif" font-size="36" font-weight="800" letter-spacing="-0.5">${escapeXml(clipHeadline(h))}</text>`
          );
        })
        .join('')
    : `<text x="90" y="300" fill="#f2f4f8" font-family="'DejaVu Sans',Arial,sans-serif" font-size="62" font-weight="800" letter-spacing="-1">AI news from around the world,</text>` +
      `<text x="90" y="376" fill="#f2f4f8" font-family="'DejaVu Sans',Arial,sans-serif" font-size="62" font-weight="800" letter-spacing="-1">hour by hour</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="18%" cy="12%" r="75%">
      <stop offset="0%" stop-color="#1e1b4b"/><stop offset="55%" stop-color="#0b0d1a"/><stop offset="100%" stop-color="#07090f"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="1200" height="6" fill="#6366f1"/>
  <g transform="translate(90,80)">
    <rect x="0" y="0" width="40" height="40" rx="11" fill="#6366f1"/>
    <text x="56" y="29" fill="#aeb4c2" font-family="'DejaVu Sans',Arial,sans-serif" font-size="24" font-weight="700" letter-spacing="4">MY BRAIN</text>
  </g>
  <text x="90" y="196" fill="#818cf8" font-family="'DejaVu Sans',Arial,sans-serif" font-size="30" font-weight="700" letter-spacing="6">AI NEWS DAILY${heads.length ? ' · HOT NOW' : ''}</text>
  ${body}
  <line x1="90" y1="520" x2="1110" y2="520" stroke="#232647" stroke-width="2"/>
  <text x="90" y="566" fill="#aeb4c2" font-family="'DejaVu Sans',Arial,sans-serif" font-size="24">${escapeXml(opts.date)} · refreshed every hour</text>
  <text x="1110" y="566" text-anchor="end" fill="#818cf8" font-family="'DejaVu Sans',Arial,sans-serif" font-size="26" font-weight="700">mybrain.1site.ai/radar</text>
</svg>`;
}
