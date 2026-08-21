import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ComposioProvider } from './composio.provider';
import { KNOWLEDGE_NOTES, KnowledgeNote, notesFor } from './knowledge-notes';
import { ScrapeCreatorsProvider } from './scrapecreators.provider';
import { WhatsAppProvider } from './whatsapp.provider';
import { isServiceToolId, parseServiceToolId, ServiceAction } from './service-provider';

/**
 * The know-how layer (BEA-1368, `specs/THINKING-BUILDER.md` §A): ONE fact card per action id, so
 * a builder reads facts instead of a one-line tool name.
 *
 * Three parts, merged in this order and each said with its source:
 *  - **spec** — what the vendor states: params (+enums), the answer's fields, how it pages, what it
 *    costs in prose. ScrapeCreators from the parsed OpenAPI already in the provider (`generateFromSpec`
 *    keeps params, tags, the 200 example, the cost sentence); Composio from its exact `GET /tools/<SLUG>`
 *    (`input_parameters` + `output_parameters`) — through the provider's own `getAction()` and its cache,
 *    never a second HTTP client.
 *  - **observed** — what actually happened, from `ToolCall` rows of the last 30 days: fields seen in
 *    recorded answers (a capped walk, secrets never copied), items per page when a whole page was
 *    recorded, real credits (typical · min · max), and HEALTH over the last 24 h — successes vs
 *    failures and the last error in plain words. A `not_found` on a SEARCH endpoint is "empty
 *    answers", said as such, and still `ok:false` when it is every call.
 *  - **notes** — the hand-kept traps in `knowledge-notes.ts`.
 *
 * Cards are cached 10 minutes. Nothing here is on the catalog's path — the catalog never waits on a card.
 */

export type KnowledgeParam = { name: string; required: boolean; type?: string; enum?: string[]; description?: string; example?: any };
export type FieldKind = 'date' | 'number' | 'text' | 'id' | 'url' | 'list' | 'bool' | 'object';
export type KnowledgeField = {
  /** Dotted path from the answer's data root; `posts[].caption` for an item inside a list. */
  path: string;
  kind: FieldKind;
  example?: any;
  /** true = it appeared in a real recorded answer; false = the spec says so but no answer has shown it yet. */
  seen: boolean;
  description?: string;
};
export type KnowledgePaging = { how: 'cursor' | 'page' | 'none'; field?: string; pageSize?: number; cap?: number; source: 'spec' | 'observed' | 'notes' | 'none' };
export type KnowledgeCost = { free?: boolean; credits?: { typical: number; min: number; max: number }; note?: string; source: 'observed' | 'spec' | 'notes' | 'provider' | 'unknown' };
export type KnowledgeHealth = {
  ok: boolean;
  /** false when nothing has been recorded in 24 h — `ok` is then a default, not a verdict. */
  known: boolean;
  lastOkAt?: string;
  lastFailAt?: string;
  successesLast24h: number;
  failuresLast24h: number;
  /** Failures that were the vendor's "nothing matches" on a search endpoint — empty answers, not breakage. */
  emptyLast24h: number;
  callsLast30d: number;
  lastError?: string;
  note?: string;
};
export type ToolKnowledge = {
  actionId: string;
  name: string;
  service: string;
  /** Which side of the seam it comes from: `social` (the social provider) or `services` (everything else). */
  provider: 'social' | 'services';
  description?: string;
  params: KnowledgeParam[];
  fields: KnowledgeField[];
  /** true when at least one field is a date — the builder's "can this do 'last 30 days'?". */
  hasDateField: boolean;
  /** The vendor's own sentence about the answer, when the schema has no fields to list. */
  responseNote?: string;
  paging: KnowledgePaging;
  cost: KnowledgeCost;
  health: KnowledgeHealth;
  notes: string[];
  retired?: boolean;
  updatedAt: string;
};

const CACHE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
/** ToolCall rows read per action — the newest N inside the window. */
const ROWS_PER_ACTION = 150;
/** Recorded answers walked for fields — enough to see every field, cheap enough to do at once. */
const RESULTS_WALKED = 12;
const MAX_FIELDS = 80;
const MAX_DEPTH = 4;
const MAX_LOOKUP = 50;
/** How many provider fetches run at once on a cold lookup. */
const FETCH_AT_ONCE = 6;

/** Same rule as the ToolCall recorder: a key that says it is a secret never carries an example. */
const SECRET_KEY_RE = /secret|token|password|api[-_ ]?key|credential|private[-_ ]?key|authorization|cookie|session/i;
const DATE_KEY_RE = /(^|_)(date|time|timestamp|datetime|at|created|updated|published|posted|taken|modified|expires?|expiry)(_|$)|(_at|_on|_date|_time|timestamp|datetime)$|^(created|updated|published|posted|taken)/i;
const ID_KEY_RE = /(^|_)(id|pk|uuid|shortcode|guid|slug)$|_id$|^id_|(^|_)ids$/i;
const URL_KEY_RE = /url|link|href|uri|permalink/i;
/** Their "nothing matched" answers on a search — an empty day, not a broken tool. */
const EMPTY_ANSWER_RE = /not[_ ]found|no (posts|reels|results|videos|items|users|profiles|scrapeable [a-z]+) found|nothing found|does not have a popular page|no .* found/i;
/** A gate's own rows (BEA-1348): held for approval, or refused — nothing was tried, so neither a success nor a failure. */
const NOT_TRIED_RE = /^Held for your approval|^You said no, so nothing was done/i;
/** Fields of the vendor's envelope, not of the answer. Skipped so a card is about the data. */
const ENVELOPE_KEYS = new Set(['success', 'successful', 'credits_remaining', 'credits_charged', 'error', 'message']);
const CURSOR_PARAMS = ['cursor', 'next_max_id', 'max_id', 'max_cursor', 'min_time', 'next_page_id', 'page_token', 'pagetoken', 'next_page_token', 'after', 'starting_after', 'end_cursor', 'offset'];
const PAGE_PARAMS = ['page', 'page_number', 'pagenumber', 'page_no'];

type Row = { ok: boolean; gated: boolean; error: string | null; result: string | null; credits: number | null; createdAt: Date };

/** The card's own picture of a recorded ToolCall row — what the observed part reads. */
export type KnowledgeRow = Partial<Row> & { createdAt: Date | string };

// ---- pure helpers (exported for the tests) -------------------------------------------------

/** What kind of thing a value is, from its key and its shape. */
export function kindOf(key: string, value: any): FieldKind {
  if (Array.isArray(value)) return 'list';
  if (value !== null && typeof value === 'object') return 'object';
  if (typeof value === 'boolean') return 'bool';
  const k = String(key || '');
  if (typeof value === 'number') {
    if (DATE_KEY_RE.test(k) && value > 1_000_000_000) return 'date'; // epoch seconds or ms
    if (ID_KEY_RE.test(k)) return 'id';
    return 'number';
  }
  if (typeof value === 'string') {
    if (/^https?:\/\//i.test(value)) return 'url';
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/.test(value) && (DATE_KEY_RE.test(k) || value.length <= 30)) return 'date';
    if (DATE_KEY_RE.test(k) && /^\d{9,13}$/.test(value)) return 'date';
    if (ID_KEY_RE.test(k)) return 'id';
    if (URL_KEY_RE.test(k) && /^\//.test(value)) return 'url';
    return 'text';
  }
  // null / undefined — the key is all we have
  if (DATE_KEY_RE.test(k)) return 'date';
  if (ID_KEY_RE.test(k)) return 'id';
  if (URL_KEY_RE.test(k)) return 'url';
  return 'text';
}

/** The kind a JSON-schema node describes. */
export function kindOfSchema(key: string, node: any): FieldKind {
  const type = Array.isArray(node?.type) ? node.type.find((t: string) => t !== 'null') : node?.type;
  if (type === 'array') return 'list';
  if (type === 'object' || node?.properties) return 'object';
  if (type === 'boolean') return 'bool';
  const k = String(key || '');
  if (type === 'integer' || type === 'number') {
    if (DATE_KEY_RE.test(k) && /timestamp|epoch|unix/i.test(`${k} ${node?.description || ''}`)) return 'date';
    return ID_KEY_RE.test(k) ? 'id' : 'number';
  }
  if (node?.format === 'date-time' || node?.format === 'date') return 'date';
  if (node?.format === 'uri' || node?.format === 'url') return 'url';
  if (DATE_KEY_RE.test(k)) return 'date';
  if (ID_KEY_RE.test(k)) return 'id';
  if (URL_KEY_RE.test(k)) return 'url';
  return 'text';
}

/** An example worth showing: short, never a secret, never a signed link's query string. */
export function safeExample(key: string, value: any): any {
  if (SECRET_KEY_RE.test(String(key || ''))) return undefined;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  let s = value.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (/^https?:\/\//i.test(s)) s = s.split('?')[0]; // a signed CDN link is a credential-ish thing
  // A long run with no spaces is a token, a hash or a blob — nothing a reader learns from.
  if (s.length > 40 && !/\s/.test(s) && !/^https?:\/\//i.test(s)) return undefined;
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/**
 * The fields of one answer — a walk over the real value, capped in depth and count. Arrays are
 * read through their first item (`posts[].caption`).
 */
export function fieldsOfValue(data: any, opts: { skipEnvelope?: boolean; seen?: boolean } = {}): KnowledgeField[] {
  const seenFlag = opts.seen !== false; // a real answer by default; the spec's example passes false
  const out: KnowledgeField[] = [];
  const seen = new Set<string>();
  const walk = (v: any, prefix: string, depth: number) => {
    if (out.length >= MAX_FIELDS || depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      const first = v.find((x) => x !== null && x !== undefined);
      if (first !== undefined && typeof first === 'object') walk(first, `${prefix}[]`, depth + 1);
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (out.length >= MAX_FIELDS) return;
      if (!prefix && opts.skipEnvelope && ENVELOPE_KEYS.has(k)) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      if (seen.has(path)) continue;
      seen.add(path);
      const kind = kindOf(k, val);
      const field: KnowledgeField = { path, kind, seen: seenFlag };
      const ex = kind === 'list' || kind === 'object' ? undefined : safeExample(k, val);
      if (ex !== undefined) field.example = ex;
      out.push(field);
      if (kind === 'list' || kind === 'object') walk(val, path, depth + 1);
    }
  };
  walk(data, '', 0);
  return out;
}

/** The fields a JSON schema promises — same walk, over `properties`/`items`. */
export function fieldsOfSchema(schema: any, opts: { root?: string } = {}): KnowledgeField[] {
  const out: KnowledgeField[] = [];
  const walk = (node: any, prefix: string, depth: number) => {
    if (!node || typeof node !== 'object' || out.length >= MAX_FIELDS || depth > MAX_DEPTH) return;
    const props = node.properties && typeof node.properties === 'object' ? node.properties : null;
    if (props) {
      for (const [k, sub] of Object.entries<any>(props)) {
        if (out.length >= MAX_FIELDS) return;
        if (!prefix && ENVELOPE_KEYS.has(k)) continue;
        const path = prefix ? `${prefix}.${k}` : k;
        const kind = kindOfSchema(k, sub);
        const field: KnowledgeField = { path, kind, seen: false };
        const desc = String(sub?.description || '').replace(/\s+/g, ' ').trim();
        if (desc) field.description = desc.slice(0, 160);
        const ex = Array.isArray(sub?.examples) ? sub.examples[0] : sub?.example;
        const safe = kind === 'list' || kind === 'object' ? undefined : safeExample(k, ex);
        if (safe !== undefined) field.example = safe;
        out.push(field);
        if (kind === 'object') walk(sub, path, depth + 1);
        else if (kind === 'list') walk(sub?.items, `${path}[]`, depth + 1);
      }
      return;
    }
    if (node.items && typeof node.items === 'object') walk(node.items, `${prefix}[]`, depth + 1);
  };
  let start = schema;
  if (opts.root && schema?.properties?.[opts.root]) start = schema.properties[opts.root];
  walk(start, '', 0);
  return out;
}

/**
 * Keys out of a recorded answer that was CUT at the recorder's cap (pretty JSON, 2000 chars) and
 * so does not parse. Only scalar `"key": value` pairs are read, flat — enough to know the field
 * exists and roughly what it is; nothing is invented about where it sits.
 */
export function fieldsOfTruncated(text: string): KnowledgeField[] {
  const out: KnowledgeField[] = [];
  const seen = new Set<string>();
  const re = /"([A-Za-z0-9_.-]{1,64})"\s*:\s*("(?:[^"\\]|\\.){0,300}"|-?\d+(?:\.\d+)?|true|false|null|\[|\{)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < MAX_FIELDS) {
    const key = m[1];
    if (seen.has(key) || ENVELOPE_KEYS.has(key)) continue;
    seen.add(key);
    const raw = m[2];
    let value: any;
    if (raw === '[') value = [];
    else if (raw === '{') value = {};
    else {
      try { value = JSON.parse(raw); } catch { value = raw; }
    }
    const kind = kindOf(key, value);
    const field: KnowledgeField = { path: key, kind, seen: true };
    const ex = kind === 'list' || kind === 'object' ? undefined : safeExample(key, value);
    if (ex !== undefined) field.example = ex;
    out.push(field);
  }
  return out;
}

/** A spec that showed a schema where an example was expected (`{type:'object', properties:{…}}`). */
export function looksLikeSchema(v: any): boolean {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string' && (('properties' in v) || ('items' in v)) && Object.keys(v).length <= 6;
}

/** The biggest list in an answer — the page — and how many items it held. */
export function pageSizeOf(data: any): number | undefined {
  let best: number | undefined;
  const walk = (v: any, depth: number) => {
    if (depth > 3 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      if (v.length && typeof v[0] === 'object' && (best === undefined || v.length > best)) best = v.length;
      return;
    }
    for (const val of Object.values(v)) walk(val, depth + 1);
  };
  walk(data, 0);
  return best;
}

/** How the spec says this action pages: which parameter, cursor or page, and any stated cap. */
export function pagingOfSchema(schema: any): { how: 'cursor' | 'page' | 'none'; field?: string; cap?: number } {
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const names = Object.keys(props);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const capOf = (name: string): number | undefined => {
    const text = `${props[name]?.description || ''} ${props[name]?.title || ''}`;
    const m = text.match(/(?:between 1 and|maximum (?:cursor|page)(?: number)?(?: is)?|cannot exceed|max(?:imum)? of|up to|no more than)\s*(\d{1,4})\b/i);
    if (m) return Number(m[1]);
    const m2 = text.match(/(?:page|cursor)\s+(\d{1,4})\s+or\s+(?:greater|more|higher)/i);
    return m2 ? Number(m2[1]) - 1 : undefined;
  };
  for (const c of CURSOR_PARAMS) {
    const n = lower.get(c);
    if (n) return { how: 'cursor', field: n, cap: capOf(n) };
  }
  for (const p of PAGE_PARAMS) {
    const n = lower.get(p);
    if (n) return { how: 'page', field: n, cap: capOf(n) };
  }
  return { how: 'none' };
}

/** The number in the vendor's cost sentence — "Each successful request costs 1 credit." → 1. */
export function creditsFromProse(hint?: string): number | undefined {
  const m = String(hint || '').match(/(\d+)\s*credits?/i);
  return m ? Number(m[1]) : undefined;
}

/** A recorded error, minus our own "X could not do that:" prefix, for the health line. */
export function plainErrorText(error: string | null | undefined): string | undefined {
  const raw = String(error || '').trim();
  if (!raw) return undefined;
  return raw.replace(/^[^:]{1,60} could not do that:\s*/i, '').slice(0, 240);
}

/** true when this id names a search — where a not_found is an empty answer, not a broken tool (BEA-1359). */
export function isSearchAction(actionId: string): boolean {
  return /search|find|lookup|query|discover|trending|popular/i.test(String(actionId || '').split('.').pop() || '');
}

/** The credits seen: the usual charge (most frequent non-zero), the smallest and the largest. */
export function creditsSeen(rows: KnowledgeRow[]): { typical: number; min: number; max: number; samples: number } | undefined {
  const vals = rows.filter((r) => r.ok && Number.isFinite(r.credits as number)).map((r) => Number(r.credits));
  if (!vals.length) return undefined;
  const counts = new Map<number, number>();
  for (const v of vals) if (v > 0) counts.set(v, (counts.get(v) || 0) + 1);
  const typical = counts.size ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] : 0;
  return { typical, min: Math.min(...vals), max: Math.max(...vals), samples: vals.length };
}

const HOUR_MIN_Z = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

/**
 * Health from the rows of the last 30 days (newest first). A gate's own rows — held for approval,
 * or refused — are neither a success nor a failure: nothing was tried. An approved call that then
 * ran and failed is `gated:true` too, and IS a failure, so the error text decides, not the flag.
 */
export function healthOf(actionId: string, rows: KnowledgeRow[], now = Date.now()): KnowledgeHealth {
  const tried = rows
    .filter((r) => !(r.gated && !r.ok && NOT_TRIED_RE.test(String(r.error || ''))))
    .map((r) => ({ ...r, at: new Date(r.createdAt).getTime() }))
    .filter((r) => Number.isFinite(r.at))
    .sort((a, b) => b.at - a.at);
  const search = isSearchAction(actionId);
  const isEmpty = (r: { error?: string | null }) => search && EMPTY_ANSWER_RE.test(String(r.error || ''));
  const day = tried.filter((r) => now - r.at <= DAY_MS);
  const successes = day.filter((r) => r.ok).length;
  const failures = day.filter((r) => !r.ok).length;
  const empty = day.filter((r) => !r.ok && isEmpty(r)).length;
  const lastOk = tried.find((r) => r.ok);
  const lastFail = tried.find((r) => !r.ok);
  const health: KnowledgeHealth = {
    ok: true,
    known: day.length > 0,
    successesLast24h: successes,
    failuresLast24h: failures,
    emptyLast24h: empty,
    callsLast30d: tried.length,
  };
  if (lastOk) health.lastOkAt = new Date(lastOk.at).toISOString();
  if (lastFail) {
    health.lastFailAt = new Date(lastFail.at).toISOString();
    const t = plainErrorText(lastFail.error);
    if (t) health.lastError = t;
  }
  if (!day.length) {
    health.note = lastOk ? `Not used in the last 24 h. Last worked ${new Date(lastOk.at).toISOString().slice(0, 16).replace('T', ' ')}Z.` : tried.length ? 'Not used in the last 24 h, and no success recorded in 30 days.' : 'No calls recorded yet.';
    if (!lastOk && lastFail) health.ok = false;
    return health;
  }
  if (successes > 0 && failures === 0) {
    health.note = `Working — ${successes} of ${successes} call${successes === 1 ? '' : 's'} succeeded in the last 24 h.`;
    return health;
  }
  if (successes > 0) {
    const emptyPart = empty ? ` (${empty} of those were empty answers on a search)` : '';
    health.note = `${successes} succeeded, ${failures} failed in the last 24 h${emptyPart}. Last failure: ${health.lastError || 'no reason recorded'}.`;
    return health;
  }
  // Every call in 24 h failed. Since when? Walk back through the streak (may reach past 24 h).
  let since = day[day.length - 1].at;
  for (const r of tried) {
    if (r.ok) break;
    since = r.at;
  }
  const sinceD = new Date(since);
  const sinceText = now - since > DAY_MS ? `${sinceD.toISOString().slice(0, 10)} ${HOUR_MIN_Z(sinceD)}` : HOUR_MIN_Z(sinceD);
  health.ok = false;
  if (empty === failures) {
    health.note = `Answered not_found (empty answers) for every call since ${sinceText} — ${failures} call${failures === 1 ? '' : 's'}, nothing found. On a search this can be the vendor's index being out, not your query.`;
  } else {
    health.note = `Failed for every call since ${sinceText} — ${failures} call${failures === 1 ? '' : 's'}. Last error: ${health.lastError || 'no reason recorded'}.`;
  }
  return health;
}

/** Spec fields ∪ observed fields, by path; a spec field that was seen becomes `seen:true` and keeps the real example. */
export function mergeFields(spec: KnowledgeField[], observed: KnowledgeField[]): KnowledgeField[] {
  const byPath = new Map<string, KnowledgeField>();
  const leaf = (p: string) => p.split('.').pop()!.replace(/\[\]$/, '');
  for (const f of spec) byPath.set(f.path, { ...f });
  const specByLeaf = new Map<string, KnowledgeField>();
  for (const f of spec) if (!specByLeaf.has(leaf(f.path))) specByLeaf.set(leaf(f.path), byPath.get(f.path)!);
  for (const o of observed) {
    const hit = byPath.get(o.path) || (o.path.includes('.') ? undefined : specByLeaf.get(leaf(o.path)));
    if (hit) {
      hit.seen = true;
      if (o.example !== undefined) hit.example = o.example;
      if (hit.kind === 'text' && o.kind !== 'text') hit.kind = o.kind;
    } else if (byPath.size < MAX_FIELDS) {
      byPath.set(o.path, { ...o });
    }
  }
  return [...byPath.values()];
}

/** The params of an action, from its argument schema. */
export function paramsOf(schema: any): KnowledgeParam[] {
  const props = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required: string[] = Array.isArray(schema?.required) ? schema.required : [];
  return Object.entries<any>(props).map(([name, s]) => {
    const p: KnowledgeParam = { name, required: required.includes(name) };
    const type = Array.isArray(s?.type) ? s.type.find((t: string) => t !== 'null') : s?.type;
    if (type) p.type = String(type);
    if (Array.isArray(s?.enum) && s.enum.length) p.enum = s.enum.slice(0, 40).map((e: any) => String(e));
    const desc = String(s?.description || s?.title || '').replace(/\s+/g, ' ').trim();
    if (desc) p.description = desc.slice(0, 240);
    const ex = Array.isArray(s?.examples) ? s.examples[0] : s?.example ?? s?.default;
    const safe = safeExample(name, ex);
    if (safe !== undefined) p.example = safe;
    return p;
  });
}

// ---- the service ---------------------------------------------------------------------------

@Injectable()
export class ToolKnowledgeService {
  private readonly log = new Logger('ToolKnowledge');
  private readonly cache = new Map<string, { at: number; card: ToolKnowledge | null }>();
  private readonly inflight = new Map<string, Promise<ToolKnowledge | null>>();

  constructor(
    private readonly services: ComposioProvider,
    private readonly social: ScrapeCreatorsProvider,
    // Optional + LAST — spec files build this positionally with fewer args; without it the
    // observed part is simply empty and the card is spec + notes.
    private readonly prisma?: PrismaService,
    // The third provider (BEA-1384). Its cards read like a Services card (no metering, schema-only
    // spec part); the 24h-window / approved-template truths ride in as notes.
    private readonly whatsapp?: WhatsAppProvider,
  ) {}

  /** The hand-kept notes in use — swapped only by the tests. */
  private notes: KnowledgeNote[] = KNOWLEDGE_NOTES;
  useNotes(notes: KnowledgeNote[]) {
    this.notes = notes;
    this.cache.clear();
  }

  /** One card, from cache when younger than 10 minutes. `null` = not an action we know. */
  async card(actionId: string, opts: { fresh?: boolean } = {}): Promise<ToolKnowledge | null> {
    const id = String(actionId || '').trim();
    if (!isServiceToolId(id)) return null;
    const hit = this.cache.get(id);
    if (!opts.fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.card;
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.build(id)
      .catch((e: any) => {
        this.log.warn(`card(${id}) failed: ${e?.message || e}`);
        return hit?.card ?? null;
      })
      .then((card) => {
        this.cache.set(id, { at: Date.now(), card });
        this.inflight.delete(id);
        return card;
      });
    this.inflight.set(id, p);
    return p;
  }

  /** Many at once (the builder's shortlist): ≤ 50 ids, a few provider fetches at a time, ids it does not know are left out. */
  async lookup(ids: string[]): Promise<ToolKnowledge[]> {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter((x) => isServiceToolId(x)))].slice(0, MAX_LOOKUP);
    const out: (ToolKnowledge | null)[] = new Array(wanted.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < wanted.length) {
        const i = next++;
        out[i] = await this.card(wanted[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(FETCH_AT_ONCE, wanted.length) }, worker));
    return out.filter((c): c is ToolKnowledge => !!c);
  }

  /** Forget everything (tests, and after a spec refresh). */
  clear() {
    this.cache.clear();
  }

  // ---- building one ------------------------------------------------------------------------

  private async build(actionId: string): Promise<ToolKnowledge | null> {
    const parsed = parseServiceToolId(actionId);
    if (!parsed) return null;
    const mine = await this.social?.owns?.(actionId).catch(() => false);
    // WhatsApp's ids never reach the general provider (the service is blocked there on purpose),
    // so its cards must be fetched from its own provider — and drawn like a Services card: no
    // metering, and the spec part is the argument schema alone.
    const wa = !mine && !!this.whatsapp?.owns?.(actionId);
    const provider: 'social' | 'services' = mine ? 'social' : 'services';
    const action: ServiceAction | null = mine
      ? await this.social.getAction(actionId).catch(() => null)
      : wa
        ? await this.whatsapp!.getAction(actionId).catch(() => null)
        : await this.services?.getAction?.(actionId).catch(() => null);
    if (!action) return null;

    const rows = await this.rows(parsed.service, actionId);
    const notes = notesFor(actionId, parsed.service, this.notes);

    // ---- spec part
    const params = paramsOf(action.schema);
    const specFields = provider === 'services'
      ? fieldsOfSchema(action.responseSchema, { root: 'data' })
      : action.responseSchema || looksLikeSchema(action.responseExample)
        ? fieldsOfSchema(action.responseSchema || action.responseExample)
        : fieldsOfValue(action.responseExample, { skipEnvelope: true, seen: false });
    const responseNote = provider === 'services' ? this.responseNoteOf(action.responseSchema) : undefined;

    // ---- observed part
    const observedFields: KnowledgeField[] = [];
    let observedPage: number | undefined;
    let walked = 0;
    for (const r of rows) {
      if (!r.ok || !r.result || walked >= RESULTS_WALKED) continue;
      walked++;
      let data: any;
      try { data = JSON.parse(r.result); } catch { data = undefined; }
      if (data !== undefined) {
        observedFields.push(...fieldsOfValue(data, { skipEnvelope: true }));
        const n = pageSizeOf(data);
        if (n !== undefined && (observedPage === undefined || n > observedPage)) observedPage = n;
      } else {
        observedFields.push(...fieldsOfTruncated(r.result));
      }
    }
    const fields = mergeFields(specFields, observedFields);
    const seenCredits = creditsSeen(rows);
    const health = healthOf(actionId, rows);

    // ---- paging: spec first, then a note, then what was observed
    const noteWithPaging = notes.find((n) => n.paging);
    const specPaging = pagingOfSchema(action.schema);
    const paging: KnowledgePaging = specPaging.how !== 'none'
      ? { how: specPaging.how, field: specPaging.field, cap: specPaging.cap, source: 'spec' }
      : noteWithPaging?.paging?.how
        ? { how: noteWithPaging.paging.how, source: 'notes' }
        : { how: 'none', source: 'none' };
    if (paging.cap === undefined && noteWithPaging?.paging?.cap !== undefined) paging.cap = noteWithPaging.paging.cap;
    // Items per page is only a page size when the action PAGES — a one-shot answer that happens
    // to hold a list of 1 (a new sheet's `sheets`) is not "1 per page".
    if (paging.how !== 'none') {
      if (observedPage !== undefined) paging.pageSize = observedPage;
      else if (noteWithPaging?.paging?.pageSize !== undefined) paging.pageSize = noteWithPaging.paging.pageSize;
    }
    if (paging.field === undefined) delete paging.field;
    if (paging.cap === undefined) delete paging.cap;

    // ---- cost: real charges first; else the vendor's prose; else a note; Composio is free
    const noteWithCost = notes.find((n) => n.cost);
    let cost: KnowledgeCost;
    if (provider === 'services') cost = { free: true, note: 'No metered cost — it runs on the connected account.', source: 'provider' };
    else if (seenCredits && seenCredits.samples > 0) cost = { credits: { typical: seenCredits.typical, min: seenCredits.min, max: seenCredits.max }, source: 'observed', ...(action.costHint ? { note: action.costHint } : noteWithCost?.cost?.note ? { note: noteWithCost.cost.note } : {}) };
    else if (creditsFromProse(action.costHint) !== undefined) { const c = creditsFromProse(action.costHint)!; cost = { credits: { typical: c, min: c, max: c }, note: action.costHint, source: 'spec' }; }
    else if (noteWithCost?.cost?.credits !== undefined) { const c = noteWithCost.cost.credits; cost = { credits: { typical: c, min: c, max: c }, ...(noteWithCost.cost.note ? { note: noteWithCost.cost.note } : {}), source: 'notes' }; }
    else if (noteWithCost?.cost?.note) cost = { note: noteWithCost.cost.note, source: 'notes' };
    else cost = { note: 'Usually 1 credit; the real charge is read off every answer.', source: 'unknown' };

    const card: ToolKnowledge = {
      actionId,
      name: action.name,
      service: parsed.service,
      provider,
      ...(action.description ? { description: String(action.description).slice(0, 600) } : {}),
      params,
      fields,
      hasDateField: fields.some((f) => f.kind === 'date'),
      ...(responseNote ? { responseNote } : {}),
      paging,
      cost,
      health,
      notes: notes.flatMap((n) => n.notes),
      ...(action.retired ? { retired: true } : {}),
      updatedAt: new Date().toISOString(),
    };
    return card;
  }

  /** The vendor's own sentence about the answer, when the schema has no fields — Composio's `data: {additionalProperties:true, description}`. */
  private responseNoteOf(schema: any): string | undefined {
    const data = schema?.properties?.data;
    if (!data || typeof data !== 'object') return undefined;
    if (data.properties && Object.keys(data.properties).length) {
      // One level down can still be a bare bag (`response_data` with a description only).
      const only = Object.values<any>(data.properties);
      if (only.length === 1 && !only[0]?.properties && only[0]?.description) return String(only[0].description).replace(/\s+/g, ' ').slice(0, 300);
      return undefined;
    }
    return data.description ? String(data.description).replace(/\s+/g, ' ').slice(0, 300) : undefined;
  }

  /** The newest rows for this action inside the window; empty when there is no database (spec harnesses). */
  private async rows(service: string, actionId: string): Promise<KnowledgeRow[]> {
    try {
      const rows = await this.prisma?.toolCall?.findMany?.({
        where: { service, action: actionId, createdAt: { gte: new Date(Date.now() - WINDOW_DAYS * DAY_MS) } },
        orderBy: { createdAt: 'desc' },
        take: ROWS_PER_ACTION,
        select: { ok: true, gated: true, error: true, result: true, credits: true, createdAt: true },
      });
      return Array.isArray(rows) ? rows : [];
    } catch (e: any) {
      this.log.warn(`could not read ToolCall rows for ${actionId}: ${e?.message || e}`);
      return [];
    }
  }
}
