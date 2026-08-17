import { createHash } from 'crypto';
import { ENVELOPE, findList, flatten, unwrap } from './rows';

/**
 * "What changed since last time?" (BEA-1358) — design: `specs/SOCIAL.md`. Pure — no I/O — so it
 * is tested on its own, and generic on purpose: only Social wires it in today, but nothing here
 * knows a platform. Three shapes:
 *
 *  - a **list** (posts, videos, ads, comments, users) → the NEW items since last time, keyed on a
 *    stable id (`id`, `shortcode`, `url`, `pk`, `aweme_id`, `video_id`…) and NEVER on position — a
 *    page that shifts by one is not one new post;
 *  - **numbers** (a profile: follower count, likes, views) → previous → current for every number
 *    that moved, and whether the owner's threshold was crossed;
 *  - **text** (a bio, a transcript, a page) → changed / unchanged, with a short "what changed" line.
 *
 * The envelope (`credits_charged`, `credits_remaining`, cursors…) and volatile CDN links (a
 * profile picture URL carries an expiry token and changes on every fetch) are left OUT of the
 * comparison, or nothing would ever be "unchanged".
 */

export type DiffShape = 'list' | 'number' | 'text';

/** The owner's number to cross — judged here, without a model. `field` blank = the main number. */
export type Threshold = { field?: string; dir: 'above' | 'below'; value: number };

export type NumberChange = { field: string; prev: number; cur: number; delta: number };
export type TextChange = { field: string; prev: string; cur: string };

export type Diff = {
  shape: DiffShape;
  changed: boolean;
  /** One plain line: "3 new posts since last time" · "followers 37,570 → 38,102" · "nothing changed". */
  summary: string;
  /** Markdown for the run screen / a Document — only what changed. Empty when nothing did. */
  detail: string;
  // list
  keyField?: string;
  newItems?: any[];
  goneCount?: number;
  total?: number;
  // numbers (a profile is a mixed object: numbers AND text fields)
  numbers?: NumberChange[];
  texts?: TextChange[];
  // the threshold, judged over the current value: met now, and whether THIS run crossed it
  threshold?: { field: string; value: number; dir: 'above' | 'below'; cur: number | null; prev: number | null; met: boolean; crossed: boolean };
};

/** Id fields, tried in this order. Never position. */
export const KEY_FIELDS = ['id', 'pk', 'shortcode', 'code', 'aweme_id', 'video_id', 'videoId', 'post_id', 'tweet_id', 'rest_id', 'ad_id', 'adArchiveID', 'ad_archive_id', 'comment_id', 'media_id', 'item_id', 'uid', 'user_id', 'username', 'url', 'link', 'permalink', 'webVideoUrl', 'share_url'];

/** The number a threshold means when the owner names none, in this order. */
export const MAIN_NUMBERS = ['follower_count', 'followers', 'followerCount', 'edge_followed_by_count', 'subscriber_count', 'subscriberCount', 'like_count', 'likes', 'diggCount', 'view_count', 'views', 'playCount', 'video_view_count', 'comment_count', 'commentCount', 'share_count', 'shareCount', 'media_count', 'post_count', 'posts', 'following_count'];

/** How much of the last result is kept on the watch row. */
export const MAX_STORED_CHARS = 200_000;
export const MAX_STORED_ITEMS = 500;

const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
/**
 * A link that changes on every fetch without meaning anything changed: a signed CDN picture
 * (`?oh=…&oe=…`, `X-Amz-…`), Instagram's link shim (`l.instagram.com/?u=…&e=<token>`), or any URL
 * carrying a long opaque token in its query. A post URL (`/p/ABC/`) or `?v=dQw4w9WgXcQ` is not.
 */
export const isVolatileUrl = (v: any): boolean => {
  if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return false;
  const q = v.indexOf('?');
  if (q === -1) return false;
  if (/[?&](oh|oe|_nc_ht|_nc_ohc|_nc_cat|x-expires|expires|sig|signature|token|Expires|X-Amz-[A-Za-z]+|e|efg|ccb|edm|ig_cache_key)=/i.test(v)) return true;
  return v.slice(q + 1).split('&').some((kv) => { const val = kv.slice(kv.indexOf('=') + 1); return kv.includes('=') && val.length >= 24 && /^[A-Za-z0-9_\-%.~]+$/.test(val); });
};

/**
 * The provider's answer with everything that changes on its own taken out: envelope keys anywhere,
 * signed/expiring links. What is left is what a person would call "the result".
 */
export function cleanForCompare(data: any, depth = 0): any {
  if (depth > 6) return undefined;
  if (Array.isArray(data)) return data.map((x) => cleanForCompare(x, depth + 1));
  if (isObj(data)) {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
      if (ENVELOPE.has(k)) continue;
      if (isVolatileUrl(v)) continue;
      const c = cleanForCompare(v, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return data;
}

/** A stable hash of a value — key order does not matter, the envelope is left out. */
export function stableHash(v: any): string {
  return createHash('sha1').update(stableJson(cleanForCompare(v))).digest('hex');
}

/** JSON with keys sorted at every level, so two equal objects always print the same. */
export function stableJson(v: any): string {
  const sort = (x: any): any => {
    if (Array.isArray(x)) return x.map(sort);
    if (isObj(x)) return Object.keys(x).sort().reduce((o: any, k) => { o[k] = sort(x[k]); return o; }, {});
    return x;
  };
  return JSON.stringify(sort(v)) ?? 'null';
}

/** The stable id of one list item: which field, and its value as text. Null when it has none we know. */
export function itemKey(item: any): { field: string; key: string } | null {
  if (!isObj(item)) return null;
  for (const f of KEY_FIELDS) {
    const v = item[f];
    if (v !== undefined && v !== null && v !== '' && (typeof v === 'string' || typeof v === 'number')) return { field: f, key: String(v) };
  }
  // one level down: `node.id`, `item.id`, `video.id` — the wrappers social APIs love
  for (const [, v] of Object.entries(item)) {
    if (isObj(v)) {
      for (const f of KEY_FIELDS.slice(0, 12)) {
        const x = (v as any)[f];
        if (x !== undefined && x !== null && x !== '' && (typeof x === 'string' || typeof x === 'number')) return { field: f, key: String(x) };
      }
    }
  }
  return null;
}

/** Which of the three shapes an answer is. A list of objects wins; then anything with numbers; else text. */
export function shapeOf(data: any): DiffShape {
  if (typeof data === 'string') return 'text';
  if (findList(data)) return 'list';
  const flat = flatten(unwrap(data));
  if (Object.values(flat).some((v) => typeof v === 'number')) return 'number';
  return 'text';
}

/** The result stored on the watch row: the list's items (capped), or the cleaned answer, as JSON within the cap. */
export function storable(data: any): string {
  const clean = cleanForCompare(data);
  const list = findList(clean);
  const keysOnly = (rows: any[], items: number) => stableJson({ __items: rows.slice(0, items), __keys: rows.map((r) => itemKey(r)?.key ?? null).filter(Boolean) });
  let json = stableJson(clean);
  if (list && (list.rows.length > MAX_STORED_ITEMS || json.length > MAX_STORED_CHARS)) {
    // Keep the ids of everything and the full items of the first N — "new since last time" needs
    // only the keys, and a 2,000-item answer must not become a 2MB row. Still too big → fewer items.
    for (const n of [MAX_STORED_ITEMS, 50, 0]) { json = keysOnly(list.rows, n); if (json.length <= MAX_STORED_CHARS) break; }
  }
  if (json.length > MAX_STORED_CHARS) json = stableJson({ __truncated: true, __hash: stableHash(clean) });
  return json;
}

/** Everything a stored result knows about its item keys, whichever way it was stored. */
function keysOf(stored: any): { keys: Set<string>; field: string | null; items: any[] } {
  if (isObj(stored) && Array.isArray(stored.__keys)) return { keys: new Set(stored.__keys.map(String)), field: null, items: Array.isArray(stored.__items) ? stored.__items : [] };
  const list = findList(stored);
  const items = list ? list.rows : [];
  const keys = new Set<string>();
  let field: string | null = null;
  for (const it of items) { const k = itemKey(it); if (k) { keys.add(k.key); field = field || k.field; } }
  return { keys, field, items };
}

const fmt = (n: number) => (Number.isFinite(n) ? n.toLocaleString('en-US') : String(n));
const LABELS: Record<string, string> = { follower_count: 'followers', followers: 'followers', followerCount: 'followers', edge_followed_by_count: 'followers', following_count: 'following', subscriber_count: 'subscribers', subscriberCount: 'subscribers', media_count: 'posts', post_count: 'posts', like_count: 'likes', likes: 'likes', diggCount: 'likes', view_count: 'views', views: 'views', playCount: 'plays', video_view_count: 'views', comment_count: 'comments', commentCount: 'comments', share_count: 'shares', shareCount: 'shares' };
/** A field name as a person says it: `follower_count` → followers, `videoViewCount` → video views. */
export const label = (f: string) => LABELS[f] || f.replace(/^edge_/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().replace(/ count$/, '');
const plural = (n: number, w: string) => `${fmt(n)} ${w}${n === 1 ? '' : 's'}`;

/**
 * The main number of an answer for the threshold: the named field when the owner named one, else
 * the first of MAIN_NUMBERS present. Over a list it is the largest value across items (a "top post
 * crosses 10k likes" watch). Null when there is no such number.
 */
export function pickNumber(data: any, field?: string): { field: string; value: number } | null {
  const list = findList(data);
  const objs: Record<string, any>[] = list ? list.rows.map(flatten) : [flatten(unwrap(data))];
  const candidates = field ? [field, field.replace(/\s+/g, '_'), field.toLowerCase()] : MAIN_NUMBERS;
  for (const f of candidates) {
    const vals = objs.map((o) => o[f]).filter((v) => typeof v === 'number' && Number.isFinite(v)) as number[];
    if (vals.length) return { field: f, value: Math.max(...vals) };
    // a named field may sit one level down as `parent_field`
    if (field) {
      for (const o of objs) {
        const k = Object.keys(o).find((x) => x.toLowerCase().endsWith('_' + f.toLowerCase()) && typeof o[x] === 'number');
        if (k) { const vals2 = objs.map((o2) => o2[k]).filter((v) => typeof v === 'number') as number[]; return { field: k, value: Math.max(...vals2) }; }
      }
    }
  }
  return null;
}

/**
 * The diff. `prev` is the stored last result (already cleaned, or as JSON-parsed off the watch row),
 * `cur` the provider's fresh answer. Never throws.
 */
export function diffResults(prev: any, cur: any, opts: { threshold?: Threshold | null } = {}): Diff {
  const curClean = cleanForCompare(cur);
  const shape = shapeOf(curClean);
  const th = judgeThreshold(prev, curClean, opts.threshold);
  let d: Diff;
  if (shape === 'list') d = diffList(prev, curClean);
  else if (shape === 'number') d = diffNumbers(prev, curClean);
  else d = diffText(prev, curClean);
  if (th) {
    d.threshold = th;
    if (th.crossed) {
      const line = `${label(th.field)} ${th.dir === 'above' ? 'went above' : 'fell below'} ${fmt(th.value)} (${th.prev === null ? '—' : fmt(th.prev)} → ${fmt(th.cur!)})`;
      d.summary = d.changed ? `${d.summary} · ${line}` : line;
      d.detail = `${d.detail}${d.detail ? '\n\n' : ''}**Threshold:** ${line}`;
      d.changed = true;
    }
  }
  return d;
}

function judgeThreshold(prev: any, cur: any, t?: Threshold | null): Diff['threshold'] | undefined {
  if (!t || !Number.isFinite(Number(t.value))) return undefined;
  const dir: 'above' | 'below' = t.dir === 'below' ? 'below' : 'above';
  const value = Number(t.value);
  const now = pickNumber(cur, t.field || undefined);
  const before = pickNumber(prev, now?.field || t.field || undefined);
  const meets = (n: number | null) => (n === null ? false : dir === 'above' ? n > value : n < value);
  const met = meets(now?.value ?? null);
  const wasMet = before ? meets(before.value) : null;
  // "Crossed" = met now and NOT met last time. With no last number (a baseline) nothing crossed —
  // the watch starts from now, and the once-only rule is kept on the watch row's alertState.
  const crossed = met && wasMet === false;
  return { field: now?.field || before?.field || t.field || 'value', value, dir, cur: now?.value ?? null, prev: before?.value ?? null, met, crossed };
}

function diffList(prev: any, cur: any): Diff {
  const list = findList(cur)!;
  const before = keysOf(prev);
  const curKeys: { item: any; key: string; field: string }[] = [];
  let unkeyed = 0;
  for (const it of list.rows) { const k = itemKey(it); if (k) curKeys.push({ item: it, key: k.key, field: k.field }); else unkeyed++; }
  const keyField = curKeys[0]?.field || before.field || 'id';
  const seen = new Set<string>();
  const newItems = curKeys.filter((c) => { if (seen.has(c.key)) return false; seen.add(c.key); return !before.keys.has(c.key); }).map((c) => c.item);
  const gone = [...before.keys].filter((k) => !seen.has(k)).length;
  const total = list.rows.length;
  // No stable id anywhere (rare) → fall back to a whole-answer hash, and say so.
  if (!curKeys.length) {
    const changed = stableHash(prev) !== stableHash(cur);
    return { shape: 'list', changed, summary: changed ? `the list changed (${plural(total, 'item')} now; these items carry no id, so I cannot say which are new)` : 'nothing changed', detail: changed ? `The list changed — ${plural(total, 'item')} now, ${plural(unkeyed, 'item')} without an id.` : '', keyField, newItems: [], goneCount: 0, total };
  }
  const changed = newItems.length > 0;
  const summary = changed ? `${plural(newItems.length, 'new item')} since last time` : gone > 0 ? `nothing new (${plural(gone, 'item')} no longer listed)` : 'nothing changed';
  const detail = changed ? `**${plural(newItems.length, 'new item')}** (by \`${keyField}\`, ${plural(total, 'item')} in the answer${gone ? `, ${gone} no longer listed` : ''}):\n\n${itemLines(newItems)}` : '';
  return { shape: 'list', changed, summary, detail, keyField, newItems, goneCount: gone, total };
}

/** A short line per item — its id, a title/caption/handle when it has one, its link. */
export function itemLines(items: any[], max = 25): string {
  const lines = items.slice(0, max).map((it) => {
    const f = flatten(it);
    const k = itemKey(it);
    const title = f.title || f.caption || f.text || f.desc || f.description || f.username || f.owner_username || f.name || f.full_name || '';
    const link = [f.url, f.link, f.permalink, f.webVideoUrl, f.share_url].find((v) => typeof v === 'string' && /^https?:/.test(v));
    const num = ['like_count', 'likes', 'diggCount', 'view_count', 'views', 'playCount', 'follower_count'].map((n) => (typeof f[n] === 'number' ? `${label(n)} ${fmt(f[n])}` : null)).filter(Boolean).slice(0, 2).join(' · ');
    return `- ${k ? `\`${k.key}\`` : '(no id)'}${title ? ` — ${String(title).replace(/\s+/g, ' ').slice(0, 120)}` : ''}${num ? ` · ${num}` : ''}${link ? ` · ${link}` : ''}`;
  });
  return lines.join('\n') + (items.length > max ? `\n- …and ${items.length - max} more` : '');
}

function diffNumbers(prev: any, cur: any): Diff {
  const a = flatten(unwrap(prev));
  const b = flatten(unwrap(cur));
  const numbers: NumberChange[] = [];
  const texts: TextChange[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = a[k]; const y = b[k];
    if (typeof y === 'number' && typeof x === 'number') { if (x !== y) numbers.push({ field: k, prev: x, cur: y, delta: y - x }); }
    else if (typeof y === 'number' && x === undefined) { /* a field that appeared — not a change in the number */ }
    else if ((typeof x === 'string' || typeof y === 'string') && String(x ?? '') !== String(y ?? '') && !isVolatileUrl(x) && !isVolatileUrl(y)) texts.push({ field: k, prev: String(x ?? ''), cur: String(y ?? '') });
  }
  // The number a person looks for first leads the sentence.
  numbers.sort((p, q) => rank(p.field) - rank(q.field));
  const changed = numbers.length > 0 || texts.length > 0;
  const head = numbers.slice(0, 3).map((n) => `${label(n.field)} ${fmt(n.prev)} → ${fmt(n.cur)}`);
  const summary = !changed ? 'nothing changed' : [...head, texts.length ? `${plural(texts.length, 'text field')} changed (${texts.slice(0, 3).map((t) => label(t.field)).join(', ')})` : ''].filter(Boolean).join(' · ') + (numbers.length > 3 ? ` · +${numbers.length - 3} more` : '');
  const detail = !changed ? '' : [
    numbers.length ? `| what | before | now | change |\n| --- | --- | --- | --- |\n${numbers.map((n) => `| ${label(n.field)} | ${fmt(n.prev)} | ${fmt(n.cur)} | ${n.delta > 0 ? '+' : ''}${fmt(n.delta)} |`).join('\n')}` : '',
    texts.length ? texts.slice(0, 10).map((t) => `**${label(t.field)}** changed:\n> was: ${t.prev.slice(0, 300) || '_(empty)_'}\n> now: ${t.cur.slice(0, 300) || '_(empty)_'}`).join('\n\n') : '',
  ].filter(Boolean).join('\n\n');
  return { shape: 'number', changed, summary, detail, numbers, texts };
}

const rank = (k: string) => { const i = MAIN_NUMBERS.indexOf(k); return i === -1 ? 999 : i; };

function diffText(prev: any, cur: any): Diff {
  const a = textOf(prev);
  const b = textOf(cur);
  if (a === b) return { shape: 'text', changed: false, summary: 'nothing changed', detail: '', texts: [] };
  const note = whatChanged(a, b);
  return { shape: 'text', changed: true, summary: note, detail: `**${note}**\n\n> was: ${snippet(a)}\n\n> now: ${snippet(b)}`, texts: [{ field: 'text', prev: a, cur: b }] };
}

/** An answer as one text: a string as is, `{text|transcript|bio|…}` unwrapped, else its stable JSON. */
export function textOf(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  const u = unwrap(v);
  if (typeof u === 'string') return u;
  if (isObj(u)) {
    for (const k of ['transcript', 'text', 'content', 'body', 'bio', 'biography', 'description', 'caption', 'html', 'markdown']) if (typeof u[k] === 'string' && u[k]) return u[k];
  }
  return stableJson(u);
}

/** "what changed", in one short line: grew / shrank / n words differ, and the first differing words. */
export function whatChanged(a: string, b: string): string {
  const wa = a.split(/\s+/).filter(Boolean); const wb = b.split(/\s+/).filter(Boolean);
  if (!wa.length) return `text appeared (${plural(wb.length, 'word')})`;
  if (!wb.length) return 'text was removed';
  let i = 0; while (i < wa.length && i < wb.length && wa[i] === wb[i]) i++;
  const grew = wb.length - wa.length;
  const where = wb.slice(i, i + 8).join(' ') || wa.slice(i, i + 8).join(' ');
  const size = grew > 0 ? `${plural(grew, 'word')} added` : grew < 0 ? `${plural(-grew, 'word')} removed` : 'same length, wording changed';
  return `text changed — ${size}${where ? `, from “${where.slice(0, 80)}${where.length > 80 ? '…' : ''}”` : ''}`;
}

const snippet = (s: string) => (s.length > 400 ? s.slice(0, 400) + '…' : s || '_(empty)_').replace(/\r?\n/g, ' ');
