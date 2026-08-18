/**
 * Turning a provider's answer into spreadsheet rows (BEA-1357). Pure — no I/O — so it is tested on
 * its own. The server-side twin of `web/src/pages/social/resultShape.ts`: 178 endpoints have 178
 * shapes, and a sheet needs flat rows with named columns.
 *
 *  - a list of objects → one row per item, nested objects flattened one level (`owner.username` →
 *    `owner_username`), arrays of scalars joined, anything deeper dropped;
 *  - an object with no list (a profile) → ONE row, so an "append every week" agent tracks a
 *    follower count over time;
 *  - a bare string (a transcript) → one row with a `text` column.
 *
 * Column order: the fields a person looks for first, then first-seen order; capped so a sheet
 * stays readable.
 */

/** Envelope keys that are never the data. */
export const ENVELOPE = new Set(['success', 'credits_remaining', 'credits_charged', 'cursor', 'next_cursor', 'has_more', 'hasMore', 'message', 'status', 'error', 'total', 'count', 'page', 'next_page', 'nextPageToken', 'next_max_id', 'more_available', 'endCursor', 'end_cursor', 'nextCursor']);

/** Fields a list usually hides under, tried first. Anything else array-of-objects works too. */
export const LIST_KEYS = ['posts', 'items', 'results', 'videos', 'reels', 'comments', 'users', 'tweets', 'ads', 'data', 'stories', 'threads', 'listings', 'products', 'reviews', 'repositories', 'pins', 'boards', 'episodes', 'tracks', 'songs', 'channels', 'clips', 'events', 'followers', 'following', 'replies', 'hashtags', 'creators', 'search_results', 'edges', 'ideas', 'aweme_list', 'user_list', 'itemList', 'nodes'];

/** Columns a sheet shows first, when the rows have them. */
const PREFERRED = ['title', 'name', 'username', 'owner_username', 'full_name', 'owner_full_name', 'handle', 'nickname', 'display_name', 'caption', 'text', 'description', 'desc', 'body', 'url', 'link', 'permalink', 'like_count', 'likes', 'diggCount', 'comment_count', 'comments', 'commentCount', 'view_count', 'views', 'playCount', 'video_view_count', 'video_play_count', 'share_count', 'shareCount', 'follower_count', 'owner_follower_count', 'followers', 'followerCount', 'subscriber_count', 'taken_at', 'created_at', 'createTime', 'date', 'published_at', 'publishedAt', 'timestamp', 'location', 'is_paid_partnership', 'is_ad', 'id'];

export const MAX_COLUMNS = 40;
export const MAX_ROWS = 1000;
/** Google's own cell limit is 50,000 characters; a caption never needs more than this. */
export const MAX_CELL = 5000;

const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: any) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** The first array-of-objects worth drawing, preferred names first, then anything at the top level. */
export function findList(data: any): { key: string; rows: any[] } | null {
  if (!isObj(data)) return Array.isArray(data) && data.length && data.every(isObj) ? { key: '', rows: data } : null;
  const tryKey = (k: string) => {
    const v = data[k];
    if (Array.isArray(v) && v.length && v.every(isObj)) return { key: k, rows: v };
    if (isObj(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2) && (v2 as any[]).length && (v2 as any[]).every(isObj)) return { key: `${k}.${k2}`, rows: v2 as any[] };
      }
    }
    return null;
  };
  for (const k of LIST_KEYS) if (k in data) { const hit = tryKey(k); if (hit) return hit; }
  for (const k of Object.keys(data)) if (!ENVELOPE.has(k)) { const hit = tryKey(k); if (hit) return hit; }
  return null;
}

/** One object → flat scalar fields, one level of nesting folded into `parent_child`. */
export function flatten(o: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (typeof o === 'string') return { text: o };
  if (!isObj(o)) return out;
  for (const [k, v] of Object.entries(o)) {
    if (ENVELOPE.has(k)) continue;
    if (v === undefined || v === '') continue;
    if (isScalar(v)) out[k] = v;
    else if (Array.isArray(v)) {
      if (v.length && v.every(isScalar) && v.length <= 20) out[k] = v.join(', ');
    } else if (isObj(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === undefined || v2 === '' || v2 === null) continue;
        if (isScalar(v2)) out[`${k}_${k2}`] = v2;
        else if (Array.isArray(v2) && v2.length && v2.every(isScalar) && v2.length <= 20) out[`${k}_${k2}`] = v2.join(', ');
      }
    }
  }
  return out;
}

export type Table = { columns: string[]; rows: any[][]; itemCount: number; listKey?: string };

/**
 * The provider's whole answer → a table. Never throws; an answer with nothing usable in it comes
 * back as zero rows and zero columns, and the caller says so.
 */
export function tableOf(data: any): Table {
  const list = findList(data);
  const items: any[] = list ? list.rows : data === undefined || data === null ? [] : [unwrap(data)];
  const flat = items.slice(0, MAX_ROWS).map(flatten).filter((r) => Object.keys(r).length);
  const seen: string[] = [];
  for (const r of flat) for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k);
  const rank = (k: string) => { const i = PREFERRED.indexOf(k); return i === -1 ? 999 : i; };
  const columns = seen
    .map((k, i) => ({ k, i }))
    .sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i)
    .map((x) => x.k)
    .slice(0, MAX_COLUMNS);
  const rows = flat.map((r) => columns.map((c) => cell(r[c])));
  return { columns, rows, itemCount: items.length, listKey: list?.key };
}

/**
 * A single answer's payload, out of its envelope: `{success, credits_charged, data:{user:{…}}}` is
 * the profile under `data.user`, not three columns of nothing. Descends while there is exactly one
 * non-envelope key and it holds an object (a few levels at most).
 */
export function unwrap(data: any): any {
  let cur = data;
  for (let i = 0; i < 4 && isObj(cur); i++) {
    const keys = Object.keys(cur).filter((k) => !ENVELOPE.has(k) && cur[k] !== null && cur[k] !== undefined);
    if (keys.length !== 1 || !isObj(cur[keys[0]])) break;
    cur = cur[keys[0]];
  }
  return cur;
}

/** A value as a sheet cell: scalars as they are, everything else as short text. */
export function cell(v: any): string | number | boolean {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > MAX_CELL ? v.slice(0, MAX_CELL - 1) + '…' : v;
  try { return JSON.stringify(v).slice(0, MAX_CELL); } catch { return String(v).slice(0, MAX_CELL); }
}

/** Re-order rows under a different header, matching by column name; blank where the sheet's column is missing. */
export function remap(table: { columns: string[]; rows: any[][] }, header: string[]): any[][] {
  const idx = header.map((h) => table.columns.findIndex((c) => norm(c) === norm(h)));
  return table.rows.map((r) => idx.map((i) => (i === -1 ? '' : cell(r[i]))));
}

/** A markdown table for the run screen / a Document, capped so a screen stays readable. */
export function markdownTable(columns: string[], rows: any[][], maxRows = 50): string {
  if (!columns.length) return '_no rows_';
  const esc = (v: any) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 160);
  const head = `| ${columns.map(esc).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.slice(0, maxRows).map((r) => `| ${columns.map((_, i) => esc(r[i])).join(' | ')} |`).join('\n');
  const more = rows.length > maxRows ? `\n\n_…and ${rows.length - maxRows} more rows_` : '';
  return `${head}\n${body}${more}`;
}

const norm = (s: string) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');

/** The `values` grid inside a Sheets read answer, wherever the provider nested it. */
export function valuesGrid(data: any, depth = 0): any[][] | null {
  if (!data || depth > 5) return null;
  if (Array.isArray(data)) {
    if (data.every((r) => Array.isArray(r))) return data as any[][];
    for (const x of data) { const g = valuesGrid(x, depth + 1); if (g) return g; }
    return null;
  }
  if (isObj(data)) {
    if (Array.isArray(data.values) && data.values.every((r: any) => Array.isArray(r))) return data.values;
    for (const v of Object.values(data)) { const g = valuesGrid(v, depth + 1); if (g) return g; }
  }
  return null;
}

/** Every `values` grid in a batch-get answer, in range order (one per requested range). */
export function valuesGrids(data: any): any[][][] {
  const out: any[][][] = [];
  const walk = (d: any, depth: number) => {
    if (!d || depth > 6) return;
    if (Array.isArray(d)) { for (const x of d) walk(x, depth + 1); return; }
    if (isObj(d)) {
      if (Array.isArray(d.values) && (d.values as any[]).every((r) => Array.isArray(r))) { out.push(d.values); return; }
      for (const v of Object.values(d)) walk(v, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/** The spreadsheet id inside a create answer, wherever the provider nested it. */
export function spreadsheetIdOf(data: any, depth = 0): string | null {
  if (!isObj(data) || depth > 4) return null;
  if (typeof data.spreadsheetId === 'string' && data.spreadsheetId) return data.spreadsheetId;
  if (typeof data.spreadsheet_id === 'string' && data.spreadsheet_id) return data.spreadsheet_id;
  for (const v of Object.values(data)) { const id = spreadsheetIdOf(v, depth + 1); if (id) return id; }
  return null;
}

/** The address a sheet opens at. The create action returns none — it is built, never guessed. */
export const sheetUrl = (id: string) => `https://docs.google.com/spreadsheets/d/${id}`;
