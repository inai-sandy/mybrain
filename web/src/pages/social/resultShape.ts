/**
 * What shape did the endpoint's answer take? (BEA-1356)
 *
 * The provider hands back the vendor's WHOLE envelope (`success · credits_charged · cursor · <the
 * data>`), and there are 178 endpoints with 178 shapes. Four drawings cover them: a transcript is
 * readable text, a list is a table, a profile is a card, and anything else is pretty JSON. This
 * file only DECIDES; the drawing is in `SocialPlatform.tsx`. Pure, so it is tested on its own.
 */

/** Envelope keys that are never the data. */
const ENVELOPE = new Set(['success', 'credits_remaining', 'credits_charged', 'cursor', 'next_cursor', 'has_more', 'hasMore', 'message', 'status', 'error', 'total', 'count', 'page', 'next_page', 'nextPageToken', 'next_max_id', 'more_available', 'endCursor', 'end_cursor', 'nextCursor']);

/** Text fields that mean "here is the transcript / body". */
const TEXT_KEYS = ['transcript', 'transcript_only_text', 'transcriptText', 'transcript_text', 'text', 'content', 'markdown', 'body'];

/** Fields a list usually hides under, tried first. Anything else array-of-objects works too. */
const LIST_KEYS = ['posts', 'items', 'results', 'videos', 'reels', 'comments', 'users', 'tweets', 'ads', 'data', 'stories', 'threads', 'listings', 'products', 'reviews', 'repositories', 'pins', 'boards', 'episodes', 'tracks', 'songs', 'channels', 'clips', 'events', 'followers', 'following', 'replies', 'hashtags', 'creators', 'search_results', 'edges', 'ideas', 'aweme_list', 'user_list', 'itemList', 'nodes'];

/** Where a profile usually sits. */
const PROFILE_KEYS = ['user', 'profile', 'data', 'channel', 'account', 'author', 'owner', 'company', 'page', 'board', 'subreddit', 'artist', 'podcast', 'video', 'post', 'tweet', 'repo', 'repository', 'product'];

/** Profile fields a card shows first, when the profile has them. */
const PROFILE_PREFERRED = ['username', 'handle', 'full_name', 'name', 'nickname', 'title', 'biography', 'bio', 'description', 'signature', 'category', 'follower_count', 'followers', 'followerCount', 'edge_followed_by', 'following_count', 'followingCount', 'media_count', 'post_count', 'video_count', 'videoCount', 'like_count', 'heartCount', 'subscriber_count', 'is_verified', 'verified', 'is_private', 'private', 'is_business', 'external_url', 'url', 'link', 'website', 'location', 'country', 'created_at', 'joined', 'id', 'pk'];

/** Columns a table shows first, when the rows have them. */
const PREFERRED_COLUMNS = ['title', 'name', 'username', 'full_name', 'handle', 'nickname', 'display_name', 'caption', 'text', 'description', 'desc', 'body', 'url', 'link', 'permalink', 'like_count', 'likes', 'diggCount', 'comment_count', 'comments', 'commentCount', 'view_count', 'views', 'playCount', 'video_view_count', 'share_count', 'shareCount', 'follower_count', 'followers', 'followerCount', 'subscriber_count', 'taken_at', 'created_at', 'createTime', 'date', 'published_at', 'publishedAt', 'timestamp', 'id'];

export type Shape = 'transcript' | 'list' | 'profile' | 'json';

export type ShapeResult = {
  shape: Shape;
  /** transcript: the text. */
  text?: string;
  /** list: the rows, and the key they were under. */
  rows?: Record<string, any>[];
  listKey?: string;
  /** profile: the flat key/value pairs, and where they came from. */
  fields?: [string, any][];
  profileKey?: string;
};

const isObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: any) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Every string that looks like a heap of words rather than a code or a URL. */
function isProse(v: any): v is string {
  return typeof v === 'string' && v.trim().length >= 40 && !/^https?:\/\//i.test(v.trim());
}

/** The first array-of-objects worth drawing, preferred names first, then anything at the top level. */
function findList(data: any): { key: string; rows: any[] } | null {
  if (!isObj(data)) return Array.isArray(data) && data.length && data.every(isObj) ? { key: '', rows: data } : null;
  const tryKey = (k: string) => {
    const v = data[k];
    if (Array.isArray(v) && v.length && v.every(isObj)) return { key: k, rows: v };
    // one level down: `data.posts`, `result.items`
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

/** The transcript, when there is one — a long string, or an array of `{text}` segments. */
function findText(data: any): string | null {
  if (typeof data === 'string') return data;
  if (!isObj(data)) return null;
  for (const k of TEXT_KEYS) {
    const v = data[k];
    if (isProse(v)) return v;
    if (Array.isArray(v) && v.length && v.every((s: any) => isObj(s) && typeof s.text === 'string')) return v.map((s: any) => s.text).join(' ');
    if (isObj(v)) {
      const inner = findText(v);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * The scalar fields of an object — the ones a person looks for first (name, bio, followers…) at
 * the top, then the rest in the object's own order; empty values dropped; arrays of scalars joined.
 */
function scalarFields(o: any, max = 60): [string, any][] {
  const all: [string, any][] = [];
  for (const [k, v] of Object.entries(o || {})) {
    if (ENVELOPE.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (isScalar(v)) all.push([k, v]);
    else if (Array.isArray(v) && v.length && v.every(isScalar) && v.length <= 12) all.push([k, v.join(', ')]);
  }
  const rank = (k: string) => { const i = PROFILE_PREFERRED.indexOf(k); return i === -1 ? 999 : i; };
  return all
    .map((f, i) => ({ f, i }))
    .sort((a, b) => rank(a.f[0]) - rank(b.f[0]) || a.i - b.i)
    .map((x) => x.f)
    .slice(0, max);
}

/** What one answer is: transcript → list → profile → json, in that order of preference. */
export function shapeOf(data: any): ShapeResult {
  if (data === undefined || data === null) return { shape: 'json' };
  // A transcript wins even when the same answer also has a list of segments beside it.
  const text = findText(data);
  const list = findList(data);
  if (text && (!list || list.key === 'transcript' || text.length > 200)) return { shape: 'transcript', text };
  if (list) return { shape: 'list', rows: list.rows, listKey: list.key };
  if (isObj(data)) {
    const hit = findProfile(data);
    if (hit) return { shape: 'profile', fields: hit.fields, profileKey: hit.key };
    const top = scalarFields(data);
    if (top.length >= 4) return { shape: 'profile', fields: top, profileKey: '' };
  }
  return { shape: 'json' };
}

/**
 * A profile can sit a few levels down (`data.data.user` on Instagram) — walk the usual names, at
 * most three deep, and take the first object with enough scalar fields to be a card.
 */
function findProfile(o: any, depth = 0): { fields: [string, any][]; key: string } | null {
  if (!isObj(o) || depth > 3) return null;
  for (const k of PROFILE_KEYS) {
    if (!isObj(o[k])) continue;
    const fields = scalarFields(o[k]);
    if (fields.length >= 3) return { fields, key: k };
    const deeper = findProfile(o[k], depth + 1);
    if (deeper) return { fields: deeper.fields, key: `${k}.${deeper.key}` };
  }
  return null;
}

/**
 * The columns a list is drawn with — the preferred names first, then whatever else is scalar in
 * the first rows, up to `max`. A nested `owner.username` / `user.username` is surfaced as one
 * column, because a post without its author is half a row.
 */
export function pickColumns(rows: Record<string, any>[], max = 6): string[] {
  const sample = rows.slice(0, 5);
  const present = new Set<string>();
  for (const r of sample) for (const [k, v] of Object.entries(r)) if (isScalar(v) && v !== null && v !== '') present.add(k);
  const cols: string[] = [];
  for (const k of PREFERRED_COLUMNS) if (present.has(k) && !cols.includes(k)) cols.push(k);
  for (const r of sample) {
    for (const nested of ['owner', 'user', 'author']) {
      if (isObj(r[nested]) && typeof r[nested].username === 'string' && !cols.includes(`${nested}.username`)) cols.push(`${nested}.username`);
    }
  }
  for (const k of present) if (!cols.includes(k)) cols.push(k);
  // Ids, positions and picture links are the least a person wants to read across a row: last.
  const low = (k: string) => (/^(id|pk|position|index|rank|shortcode|code)$/i.test(k) ? 2 : /pic|avatar|thumbnail|image_url|_pic_/i.test(k) ? 1 : 0);
  return cols
    .map((k, i) => ({ k, i }))
    .sort((a, b) => low(a.k) - low(b.k) || a.i - b.i)
    .map((x) => x.k)
    .slice(0, max);
}

/** Read `owner.username` off a row. */
export function cell(row: Record<string, any>, col: string): any {
  if (!col.includes('.')) return row[col];
  const [a, b] = col.split('.');
  return isObj(row[a]) ? row[a][b] : undefined;
}

/** A column key as a heading: `like_count` → `Like count`, `owner.username` → `Owner`. */
export function heading(col: string): string {
  const base = col.includes('.') ? col.split('.')[0] : col;
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** A value as it should read in a cell: numbers with separators, epoch seconds as a date, links as links. */
export function format(v: any, col = ''): { text: string; href?: string; kind: 'text' | 'number' | 'date' | 'link' | 'bool' | 'empty' } {
  if (v === undefined || v === null || v === '') return { text: '—', kind: 'empty' };
  if (typeof v === 'boolean') return { text: v ? 'Yes' : 'No', kind: 'bool' };
  if (typeof v === 'number') {
    if (v < 0) return { text: 'hidden', kind: 'number' }; // like_count can be -1 = hidden
    if (/(_at|_time|time|date|timestamp)$/i.test(col) && v > 1e9) {
      const ms = v > 1e12 ? v : v * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return { text: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), kind: 'date' };
    }
    return { text: v.toLocaleString(), kind: 'number' };
  }
  const s = String(v);
  if (/^https?:\/\//i.test(s)) {
    const short = s.replace(/^https?:\/\/(www\.)?/, '');
    return { text: short.length > 42 ? short.slice(0, 40) + '…' : short, href: s, kind: 'link' };
  }
  if (/(_at|date|time)$/i.test(col) && !Number.isNaN(Date.parse(s)) && s.length >= 8) {
    return { text: new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }), kind: 'date' };
  }
  return { text: s, kind: 'text' };
}

/** The result as markdown — for Save as Document and Send to Capture. */
export function toMarkdown(opts: { title: string; endpoint: string; args: Record<string, any>; credits?: number; data: any }): string {
  const s = shapeOf(opts.data);
  const head = [
    `# ${opts.title}`,
    '',
    `- **Endpoint:** \`${opts.endpoint}\``,
    Object.keys(opts.args || {}).length ? `- **Inputs:** \`${JSON.stringify(opts.args)}\`` : '',
    opts.credits !== undefined ? `- **Cost:** ${opts.credits} credit${opts.credits === 1 ? '' : 's'}${opts.credits === 0 ? ' (cached)' : ''}` : '',
    `- **Fetched:** ${new Date().toISOString()}`,
    '',
  ].filter((l) => l !== '').join('\n');
  if (s.shape === 'transcript') return `${head}\n\n${s.text}\n`;
  if (s.shape === 'list' && s.rows) {
    const cols = pickColumns(s.rows, 8);
    const esc = (t: string) => t.replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const lines = [`| ${cols.map(heading).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`];
    for (const r of s.rows) lines.push(`| ${cols.map((c) => { const f = format(cell(r, c), c); return esc(f.href ? f.href : f.text); }).join(' | ')} |`);
    return `${head}\n\n${s.rows.length} rows\n\n${lines.join('\n')}\n\n<details><summary>Raw JSON</summary>\n\n\`\`\`json\n${JSON.stringify(opts.data, null, 2).slice(0, 200000)}\n\`\`\`\n\n</details>\n`;
  }
  if (s.shape === 'profile' && s.fields) {
    return `${head}\n\n${s.fields.map(([k, v]) => `- **${heading(k)}:** ${format(v, k).href || format(v, k).text}`).join('\n')}\n\n\`\`\`json\n${JSON.stringify(opts.data, null, 2).slice(0, 200000)}\n\`\`\`\n`;
  }
  return `${head}\n\n\`\`\`json\n${JSON.stringify(opts.data, null, 2).slice(0, 200000)}\n\`\`\`\n`;
}
