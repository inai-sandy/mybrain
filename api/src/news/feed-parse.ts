/**
 * Smol AI News feed parsing (BEA-1254) — pure functions, no network, no database.
 *
 * What the feed actually is, measured 2026-08-01 against https://news.smol.ai/rss.xml:
 *   - 688 <item> elements, one per day, going back about two years
 *   - only the newest ~10 carry <content:encoded>; the rest are title + a ~900-char
 *     <description> + link, and cannot be split into stories
 *   - <content:encoded> holds ESCAPED html (`&lt;p&gt;…`), 41k–61k chars. The live feed uses
 *     plain entity escaping and NO CDATA anywhere — `uncdata()` below only exists so a CDATA
 *     wrapper would not break us if the publisher ever switches. Both shapes are tested.
 *   - each item carries 21–38 <category> tags — these are entities (model names, companies,
 *     Twitter handles like `deepseek`, `gpt-5.6-luna`, `_akhaliq`), not sections
 *   - published 05:44 GMT daily, which is 11:14 am IST
 *
 * There is no XML library in this API and the feed is machine-generated and consistent, so this
 * is deliberately small and hand-rolled. The safety net is BEA-1255's count assertion: if this
 * parser ever quietly loses something, the story counts stop balancing and the run fails loudly
 * rather than publishing a short edition that looks complete.
 */

export type FeedItem = {
  /** The issue URL — stable, unique, and what we key on. */
  link: string;
  title: string;
  pubDate: Date | null;
  description: string;
  /** Unescaped HTML of the full issue, or null when the feed only gave us a summary. */
  contentHtml: string | null;
  /** Entity tags straight from <category> — free per-issue tagging. */
  entities: string[];
};

const NAMED: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
  nbsp: ' ',
};

/**
 * Decode XML/HTML entities in ONE pass.
 *
 * One pass matters. Decoding `&lt;` and then `&amp;` separately would turn the literal text
 * `&amp;lt;` into `<`, inventing markup that was never there. A single regex over the whole
 * string cannot double-decode, because each match is consumed once.
 *
 * Note the feed is escaped twice on purpose: the XML level yields HTML, and text inside that HTML
 * carries its own entities (a `&` in a heading arrives as `&amp;#x26;`). So callers decode at the
 * XML level to get HTML, then again when pulling text out of that HTML. That is correct, not a bug.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const hit = NAMED[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/** Strip a CDATA wrapper if there is one, leaving the payload untouched otherwise. */
function uncdata(s: string): string {
  const t = s.trim();
  const m = t.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : t;
}

/** Pull the first <tag>…</tag> payload out of a chunk, already un-CDATA'd and decoded. */
function tag(chunk: string, name: string): string | null {
  const m = chunk.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  if (!m) return null;
  return decodeEntities(uncdata(m[1]));
}

/** Every <category> in a chunk, trimmed, de-duplicated, empties dropped. */
function categories(chunk: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of chunk.matchAll(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/g)) {
    const v = decodeEntities(uncdata(m[1])).trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** RFC-822 dates from the feed. Returns null rather than an Invalid Date nobody notices. */
export function parseDate(raw: string | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Parse the whole feed into items. Anything without a link is skipped — it has no identity, so it
 * could never be stored or de-duplicated — and the count of those is reported by the caller rather
 * than swallowed.
 */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/g)) {
    const chunk = m[1];
    const link = (tag(chunk, 'link') || '').trim();
    if (!link) continue;
    const content = tag(chunk, 'content:encoded');
    items.push({
      link,
      title: (tag(chunk, 'title') || '').trim(),
      pubDate: parseDate(tag(chunk, 'pubDate')),
      description: (tag(chunk, 'description') || '').trim(),
      contentHtml: content && content.trim() ? content : null,
      entities: categories(chunk),
    });
  }
  return items;
}
