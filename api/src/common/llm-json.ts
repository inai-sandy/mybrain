/**
 * Robust JSON extraction from LLM completions (BEA-884).
 *
 * Models frequently wrap JSON in ```json fences and — worse — emit RAW (unescaped) newlines/tabs
 * inside string values, which makes a plain `JSON.parse` throw. Generators that fell back to the
 * raw string on failure ended up storing the whole `{"...":"..."}` blob into a narrative field
 * (e.g. mentor guidance, book chapters). These helpers parse leniently and NEVER return a raw blob.
 */

/** Parse a JSON object out of an LLM reply. Strips fences, repairs raw control chars inside strings,
 *  then JSON.parse. Returns null (never throws) if it truly can't be parsed. */
export function looseJsonParse(raw: string | null | undefined): any {
  if (raw == null) return null;
  let s = String(raw).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i === -1 || j === -1 || j < i) return null;
  s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { /* try repair */ }
  // Repair: escape control chars that appear INSIDE string values (the common failure).
  let out = '';
  let inStr = false;
  let esc = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (esc) { out += ch; esc = false; continue; }
    if (ch === '\\') { out += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; out += ch; continue; }
    if (inStr) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  try { return JSON.parse(out); } catch { return null; }
}

/**
 * Pull a narrative text field out of an LLM reply that MAY be JSON. If the reply is JSON carrying
 * `field`, return that value; if it's plain prose, return the prose; if it looks like a JSON blob we
 * couldn't parse, extract the field by regex — but NEVER return a visible `{...}` blob to the user.
 */
export function narrativeField(raw: string | null | undefined, field: string): string {
  const parsed = looseJsonParse(raw);
  if (parsed && typeof parsed[field] === 'string' && parsed[field].trim()) return String(parsed[field]).trim();

  const s = String(raw ?? '').trim();
  const looksLikeJson = /^```?\s*\{[\s\S]*\}\s*```?$/.test(s) || (/^\{/.test(s) && new RegExp('"' + field + '"\\s*:').test(s));
  if (looksLikeJson) {
    const m = new RegExp('"' + field + '"\\s*:\\s*"([\\s\\S]*?)"\\s*(?:,\\s*"[\\w]+"\\s*:|\\}\\s*`?`?`?\\s*$)').exec(s);
    if (m) return m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\').trim();
    return ''; // a blob we can't parse — return empty rather than showing braces
  }
  return s; // plain prose
}

/** True if a stored string is (wrongly) a raw JSON blob — used by the backfill to find broken rows. */
export function looksLikeRawJsonBlob(s: string | null | undefined): boolean {
  const t = String(s ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return /^\{[\s\S]*\}$/.test(t) && /"\s*:\s*/.test(t);
}
