/**
 * BEA-1363: one-line previews of a run's result (History rows, "latest result" headline, saved-doc
 * snippets) must read as plain text. Results are markdown — a Watch job answers
 * `**Nothing changed since 18 Aug, 03:31.**  _1 credit_` — and a truncated line printed the markers.
 *
 * Rules: markers stripped (`**`, `__`, `_`, `*`, `~~`, backticks, `#` headings, `>` quotes, list
 * bullets and numbers — line-start only, so "step 2. Also" and "5 * 3" stay intact), links → their
 * text, images dropped, table rows / separator rows / `---` rules dropped, then the first
 * sentence(s) up to `max` characters, whitespace collapsed. Never returns markers; never returns
 * a table row like `| what | before |`.
 */
export function plainPreview(text: string | null | undefined, max = 160): string {
  if (!text) return '';
  const lines = String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    // Table rows, separator rows (`|---|:--:|`, `---|---`) and horizontal rules carry nothing a
    // one-liner can say. A separator is ONLY pipes/colons/dashes/spaces — `--dry-run: x` is text.
    .filter((l) => l && !/^\|/.test(l) && !/^[|:\s-]*-{2,}[|:\s-]*$/.test(l) && !/^[-*_=]{3,}$/.test(l))
    // Line-start structure: headings, quotes, bullets, numbered items.
    .map((l) => l.replace(/^(#{1,6}\s+|>\s?|[-*+•]\s+|\d+[.)]\s+)+/, ''));
  let s = lines.join(' ');
  s = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → text
    .replace(/<[^>]+>/g, '') // stray html
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // code
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(^|[^\w])[*_](.+?)[*_](?=[^\w]|$)/g, '$1$2') // italics
    .replace(/~~(.*?)~~/g, '$1') // strike
    .replace(/(^|\s)(\*{2,}|_{2,}|`+|#+)(?=\s|$)/g, '$1') // a stray marker run between spaces (`**` left over); a lone `*` is maths
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  // First sentence(s) that fit; else a clean word cut.
  let out = '';
  for (const part of s.split(/(?<=[.!?])\s+/)) {
    if (!out) { out = part; if (out.length > max) break; continue; }
    if ((out + ' ' + part).length > max) break;
    out += ' ' + part;
  }
  if (out.length > max) out = out.slice(0, max).replace(/\s+\S*$/, '').trimEnd() + '…';
  return out;
}
