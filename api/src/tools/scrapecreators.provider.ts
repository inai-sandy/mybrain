import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { ConnectorService } from '../connectors/connector.service';
import {
  ConnectResult,
  CredentialField,
  ExecuteResult,
  isServiceToolId,
  ProviderStatus,
  ServiceAccount,
  ServiceAction,
  ServiceInfo,
  ServiceProvider,
  serviceToolId,
} from './service-provider';
import { describeTransportError, fetchWithRetry, isTransportError } from './transport';

/**
 * ScrapeCreators, behind the ServiceProvider seam — the SECOND provider (BEA-1355).
 * Design: `specs/SOCIAL.md`. Shapes verified live: `specs/SCRAPECREATORS-API.md`.
 *
 * **Their OpenAPI spec is the only source of truth.** Every action here is generated from
 * `openapi.json` — name, description, parameter schema, response example — nothing is hand-written
 * and nothing is skipped: the number of actions IS the number of operations in the spec, whatever
 * that number is today (178 across 29 platforms on 2026-08-17). The spec is read at boot, again once
 * a day, and on demand (`refresh()`), so a new endpoint on their side appears here without a deploy.
 * When it cannot be read, the last good generated list is served — from memory, or from the copy
 * kept on disk across restarts — and nothing above this file waits on it.
 *
 * **Ids** are `svc:<platform>.<endpoint>` and the vendor's name never appears in one. The rule,
 * in full, because saved flows dispatch on these for ever:
 *
 *   1. The path is split as `/<version>/<platform>/<the rest>` — `/v1/instagram/search/hashtag`.
 *      A first segment that is not `v<digits>` is treated as the platform, at version 1.
 *   2. Platform and endpoint segments are lower-cased and every run of anything that is not
 *      `[a-z0-9]` becomes one `_`; camelCase splits at the hump first (`adLibrary` → `ad_library`,
 *      `apple-music` → `apple_music`).
 *   3. The endpoint is the rest of the path joined with `_` (`search/hashtag` → `search_hashtag`).
 *      A path with nothing after the platform (`/v1/linktree`) is the endpoint `get`.
 *   4. A method other than GET adds `_<method>` — `POST /v1/reddit/post/comments` and its GET twin
 *      are `svc:reddit.post_comments_post` and `svc:reddit.post_comments`.
 *   5. Versions: the LOWEST version of the same platform+endpoint keeps the bare name; a higher one
 *      adds `_v<N>` (`/v2/instagram/user/posts` is bare today because no v1 of it exists; if a v3
 *      appears it will be `svc:instagram.user_posts_v3`). Lowest-wins on purpose — a new version
 *      arriving must never rename the id already stored in someone's flow.
 *   6. Should two operations still collide after all of that, the later one (in path order) gets
 *      `_2`, `_3`… A test asserts every id is unique and that there are exactly as many as ops.
 *
 * **Credits are read, never assumed.** Every answer carries `credits_charged` at the top level
 * (1 for most calls, 15 for Instagram comments, 26 for TikTok demographics, 0 for a cache hit) and
 * `execute()` hands it back as `credits` for the ToolCall row. Everything here is a READ, so
 * nothing is ever gated. One API key per instance (`scrapecreators` connector), no OAuth.
 */

const API_BASE = process.env.SCRAPECREATORS_API_BASE || 'https://api.scrapecreators.com';
const SPEC_URL = process.env.SCRAPECREATORS_SPEC_URL || 'https://docs.scrapecreators.com/openapi.json';
/** Where the last good spec is kept across restarts. Their docs host being down must not empty Social. */
const SPEC_CACHE_FILE = () => process.env.SCRAPECREATORS_SPEC_CACHE || join(process.env.DATA_DIR || '/app/data', 'scrapecreators-openapi.json');

/** Once a day, so a new endpoint shows up within a day of them adding it. Plus on demand. */
const SPEC_REFRESH_MS = 24 * 60 * 60 * 1000;
const SPEC_TIMEOUT_MS = 30_000;
/** A scrape can take a while (transcripts, ad libraries). The caller may pass its own. */
const CALL_TIMEOUT_MS = 60_000;
/** The balance is asked for on every catalog read; one answer a minute is plenty. */
const BALANCE_CACHE_MS = 60_000;
/**
 * How long a read waits for the very first generation before answering with what it has. Under
 * the catalog's own 8s budget on purpose — the provider must never be the reason the catalog stalls.
 */
const READY_WAIT_MS = 6000;

const CONNECTOR = 'scrapecreators';
const CATEGORY = { id: 'social', name: 'Social' };
const KEY_FIELD: CredentialField = {
  name: 'apiKey',
  label: 'API key',
  description: 'From your Scrape Creators dashboard. One key covers every platform.',
  required: true,
  secret: true,
};
/** The one "account": the key. Its id is ours; the label is what the owner sees. */
const ACCOUNT: ServiceAccount = { id: 'default', label: 'Scrape Creators key', status: 'ACTIVE' };

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];

// ---- generation (pure — exported for the tests) -------------------------------------------

/** One operation as read from the spec, before it has an id. */
export type SpecOp = { method: string; path: string; version: number; platform: string; rest: string[]; op: any };

export type GeneratedPlatform = { slug: string; name: string; tags: string[]; actions: ServiceAction[] };

/** Where each argument of an action goes on the wire — kept beside the action, never in the seam. */
export type Route = { method: string; path: string; query: string[]; pathParams: string[]; body: string[] };

export type Generated = {
  /** How many operations the spec has. The number of actions MUST equal it. */
  opCount: number;
  actions: ServiceAction[];
  byId: Map<string, ServiceAction>;
  routes: Map<string, Route>;
  platforms: GeneratedPlatform[];
  generatedAt: string;
};

/** `adLibrary` → `ad_library`, `apple-music` → `apple_music`, `credit-balance` → `credit_balance`. */
export function slugSegment(seg: string): string {
  return String(seg || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `/v2/instagram/user/posts` → `{ version: 2, platform: 'instagram', rest: ['user','posts'] }`. */
export function splitPath(path: string): { version: number; platform: string; rest: string[] } | null {
  const segs = String(path || '').split('/').filter(Boolean);
  if (!segs.length) return null;
  let version = 1;
  let i = 0;
  if (/^v\d+$/i.test(segs[0])) { version = parseInt(segs[0].slice(1), 10) || 1; i = 1; }
  const platform = slugSegment(segs[i] || '');
  if (!platform) return null;
  return { version, platform, rest: segs.slice(i + 1) };
}

/** The endpoint half of an id, before method and version suffixes. */
export function endpointName(rest: string[]): string {
  return rest.map(slugSegment).filter(Boolean).join('_') || 'get';
}

/** Every operation in the spec, in a fixed order — platform, endpoint, version, method, path. */
export function readOps(spec: any): SpecOp[] {
  const ops: SpecOp[] = [];
  for (const [path, item] of Object.entries<any>(spec?.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    const split = splitPath(path);
    if (!split) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      ops.push({ method, path, version: split.version, platform: split.platform, rest: split.rest, op });
    }
  }
  const methodRank = (m: string) => (m === 'get' ? `0` : `1${m}`);
  return ops.sort((a, b) =>
    a.platform.localeCompare(b.platform)
    || endpointName(a.rest).localeCompare(endpointName(b.rest))
    || a.version - b.version
    || methodRank(a.method).localeCompare(methodRank(b.method))
    || a.path.localeCompare(b.path));
}

/** The vendor's own sentence about cost, when the description has one. A hint for the UI only. */
function costHintOf(description: string): string | undefined {
  const text = String(description || '').replace(/\s+/g, ' ');
  const sentences = text.split(/(?<=[.!?])\s+/);
  const hit = sentences.find((s) => /\bcredits?\b/i.test(s) && /\d/.test(s));
  return hit ? hit.trim().slice(0, 200) : undefined;
}

/** The argument schema: every declared parameter plus the JSON body's fields, in one object. */
function schemaOf(op: any): { schema: any; route: Omit<Route, 'method' | 'path'> } {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  const query: string[] = [];
  const pathParams: string[] = [];
  const body: string[] = [];
  for (const p of Array.isArray(op?.parameters) ? op.parameters : []) {
    const name = String(p?.name || '');
    if (!name) continue;
    const s = { ...(p.schema || { type: 'string' }) };
    if (p.description && !s.description) s.description = p.description;
    if (p.example !== undefined && s.example === undefined) s.example = p.example;
    properties[name] = s;
    if (p.required) required.push(name);
    if (p.in === 'path') pathParams.push(name);
    else query.push(name); // query, and anything odd (header/cookie) rides along as a query field
  }
  const bodySchema = op?.requestBody?.content?.['application/json']?.schema;
  if (bodySchema && typeof bodySchema === 'object') {
    for (const [name, s] of Object.entries<any>(bodySchema.properties || {})) {
      if (properties[name]) continue;
      properties[name] = s;
      body.push(name);
    }
    for (const r of Array.isArray(bodySchema.required) ? bodySchema.required : []) if (!required.includes(r)) required.push(r);
  }
  const schema: any = { type: 'object', properties };
  if (required.length) schema.required = required;
  return { schema, route: { query, pathParams, body } };
}

function titleCase(slug: string): string {
  return slug.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The whole spec → every action, every platform, every route. Pure and deterministic: the same
 * spec always yields the same ids, and a spec with N operations always yields exactly N actions.
 */
export function generateFromSpec(spec: any): Generated {
  const ops = readOps(spec);
  const actions: ServiceAction[] = [];
  const byId = new Map<string, ServiceAction>();
  const routes = new Map<string, Route>();
  /** platform.endpoint(+method) → the version that claimed the bare name. */
  const claimed = new Map<string, number>();
  const platformOps = new Map<string, { tags: Map<string, number>; actions: ServiceAction[] }>();

  for (const o of ops) {
    let endpoint = endpointName(o.rest);
    if (o.method !== 'get') endpoint += `_${o.method}`;
    const key = `${o.platform}.${endpoint}`;
    const owner = claimed.get(key);
    if (owner === undefined) claimed.set(key, o.version);
    else if (owner !== o.version) endpoint += `_v${o.version}`;
    let id = serviceToolId(o.platform, endpoint);
    for (let n = 2; byId.has(id); n++) id = serviceToolId(o.platform, `${endpoint}_${n}`);

    const { schema, route } = schemaOf(o.op);
    const tags: string[] = Array.isArray(o.op.tags) ? o.op.tags.map((t: any) => String(t)) : [];
    const description = String(o.op.description || o.op.summary || '').trim();
    const example = o.op.responses?.['200']?.content?.['application/json'];
    const action: ServiceAction = {
      id,
      name: String(o.op.summary || titleCase(endpoint)).trim(),
      description,
      schema,
      risky: false, // every ScrapeCreators endpoint is a read; nothing here is ever gated
      service: o.platform,
      deprecated: !!o.op.deprecated,
      method: o.method.toUpperCase(),
      path: o.path,
      tags,
      costHint: costHintOf(description),
      responseExample: example?.example ?? example?.schema ?? undefined,
    };
    actions.push(action);
    byId.set(id, action);
    routes.set(id, { method: o.method.toUpperCase(), path: o.path, ...route });

    const bucket = platformOps.get(o.platform) || { tags: new Map(), actions: [] };
    for (const t of tags) bucket.tags.set(t, (bucket.tags.get(t) || 0) + 1);
    bucket.actions.push(action);
    platformOps.set(o.platform, bucket);
  }

  const platforms: GeneratedPlatform[] = [...platformOps.entries()].map(([slug, b]) => {
    // The platform's name is its shortest tag ("TikTok" over "TikTok Shop"), else the slug tidied.
    const tags = [...b.tags.keys()].sort((x, y) => b.tags.get(y)! - b.tags.get(x)! || x.localeCompare(y));
    const name = [...tags].sort((x, y) => x.length - y.length || x.localeCompare(y))[0] || titleCase(slug);
    return { slug, name, tags, actions: b.actions };
  }).sort((a, b) => b.actions.length - a.actions.length || a.slug.localeCompare(b.slug));

  return { opCount: ops.length, actions, byId, routes, platforms, generatedAt: new Date().toISOString() };
}

// ---- the provider ------------------------------------------------------------------------

@Injectable()
export class ScrapeCreatorsProvider implements ServiceProvider, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ScrapeCreators');
  /** Every endpoint here is a read. Said on the seam so the gate never re-runs the name rule on our ids. */
  readonly readOnly = true;
  private gen: Generated | null = null;
  /** Where the current list came from — for the status line and the tests. */
  private source: 'none' | 'disk' | 'live' | 'given' = 'none';
  private loading: Promise<any> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private balance: { at: number; value: ProviderStatus } | null = null;
  /** Why the last live read failed, when it did — so the Social page can say "showing the last good list". */
  private specError: string | null = null;

  constructor(private readonly connectors: ConnectorService) {}

  // ---- lifecycle ---------------------------------------------------------------------------

  onModuleInit() {
    this.loadFromDisk();
    // Never awaited: boot must not wait on their docs host, and the catalog answers from disk
    // (or the last good list) until the live spec has been read.
    this.loading = this.loadSpec().catch(() => undefined);
    this.timer = setInterval(() => { this.loadSpec().catch(() => undefined); }, SPEC_REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Read the spec from their docs host and regenerate. On failure the last good list stays.
   * Returns what happened, in a shape the Social page (BEA-1356) can show after "refresh".
   */
  async loadSpec(): Promise<{ ok: boolean; opCount: number; source: string; message?: string }> {
    try {
      const r = await fetch(SPEC_URL, { signal: AbortSignal.timeout(SPEC_TIMEOUT_MS), headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const spec: any = await r.json();
      const gen = generateFromSpec(spec);
      if (!gen.opCount) throw new Error('the spec had no operations in it');
      this.gen = gen;
      this.source = 'live';
      this.specError = null;
      this.saveToDisk(spec);
      this.log.log(`spec read: ${gen.opCount} endpoints across ${gen.platforms.length} platforms`);
      return { ok: true, opCount: gen.opCount, source: 'live' };
    } catch (e: any) {
      const why = String(e?.message || e).slice(0, 160);
      this.specError = why;
      this.log.warn(`could not read the ScrapeCreators spec (${why}) — serving the last good list (${this.gen?.opCount || 0} endpoints, ${this.source})`);
      return { ok: false, opCount: this.gen?.opCount || 0, source: this.source, message: why };
    }
  }

  /** Generate from a spec object given directly — the tests' door, and a way to pin one. */
  useSpec(spec: any): Generated {
    const gen = generateFromSpec(spec);
    this.gen = gen;
    this.source = 'given';
    return gen;
  }

  /** The current generated list, for the tests and the Social page's own counts. */
  generated(): Generated | null {
    return this.gen;
  }

  /** Where the list came from: none · disk · live · given. */
  specSource(): string {
    return this.source;
  }

  /**
   * How the list stands right now, for the Social header (BEA-1356): where it came from, when it
   * was generated, how many endpoints, and — when the last live read failed — why, so the page can
   * say "showing the last good list" instead of quietly looking current.
   */
  specState(): { source: string; generatedAt?: string; opCount: number; platformCount: number; lastError?: string } {
    return {
      source: this.source,
      generatedAt: this.gen?.generatedAt,
      opCount: this.gen?.opCount || 0,
      platformCount: this.gen?.platforms.length || 0,
      lastError: this.specError || undefined,
    };
  }

  private loadFromDisk() {
    try {
      const raw = readFileSync(SPEC_CACHE_FILE(), 'utf8');
      const gen = generateFromSpec(JSON.parse(raw));
      if (gen.opCount) { this.gen = gen; this.source = 'disk'; }
    } catch {
      /* no copy yet, or an unreadable one — the live read below is the answer */
    }
  }

  private saveToDisk(spec: any) {
    try {
      const file = SPEC_CACHE_FILE();
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(spec));
      renameSync(tmp, file);
    } catch (e: any) {
      this.log.warn(`could not keep a copy of the spec on disk: ${e?.message || e}`);
    }
  }

  /** The list, waiting a bounded moment for the first read if it is still in flight. */
  private async ready(): Promise<Generated | null> {
    if (this.gen || !this.loading) return this.gen;
    await Promise.race([this.loading, new Promise((r) => setTimeout(r, READY_WAIT_MS).unref?.())]);
    return this.gen;
  }

  // ---- the seam ----------------------------------------------------------------------------

  async status(): Promise<ProviderStatus> {
    const key = await this.apiKey();
    const gen = await this.ready();
    if (!key) return { configured: false, reachable: false, message: 'No Scrape Creators API key saved yet.', serviceCount: gen?.platforms.length };
    if (this.balance && Date.now() - this.balance.at < BALANCE_CACHE_MS) return this.balance.value;
    let value: ProviderStatus;
    try {
      const b = await this.creditBalance(key);
      value = { configured: true, reachable: true, serviceCount: gen?.platforms.length, message: `${b.toLocaleString('en-US')} credits left.` };
    } catch (e: any) {
      value = { configured: true, reachable: false, serviceCount: gen?.platforms.length, message: this.plainError(e) };
    }
    this.balance = { at: Date.now(), value };
    return value;
  }

  /** The balance itself, for the Social header. Throws when it cannot be read. */
  async creditBalance(key?: string): Promise<number> {
    const k = key || (await this.apiKey());
    if (!k) throw new Error('No Scrape Creators API key saved.');
    const r = await this.call(k, 'GET', '/v1/account/credit-balance', {}, undefined, 15_000);
    if (!r.ok) throw Object.assign(new Error(r.error || `HTTP ${r.status}`), { status: r.status });
    const n = Number(r.body?.creditCount);
    if (!Number.isFinite(n)) throw new Error('The balance did not come back as a number.');
    return n;
  }

  /**
   * Every platform in the spec, as a service. The list is public (it is their spec), so it is
   * shown with or without a key; `connected` says whether the one key is set.
   */
  async listServices(opts: { connectedOnly?: boolean; search?: string; category?: string; limit?: number } = {}): Promise<ServiceInfo[]> {
    const gen = await this.ready();
    if (!gen) return [];
    const has = !!(await this.apiKey());
    if (opts.connectedOnly && !has) return [];
    if (opts.category && String(opts.category).toLowerCase() !== CATEGORY.id) return [];
    const q = String(opts.search || '').trim().toLowerCase();
    let out = gen.platforms.filter((p) => !q || p.slug.includes(q) || p.name.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)));
    if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
    return out.map((p) => this.toServiceInfo(p, has));
  }

  async getService(slug: string): Promise<ServiceInfo | null> {
    const gen = await this.ready();
    const s = slugSegment(slug);
    const p = gen?.platforms.find((x) => x.slug === s);
    if (!p) return null;
    return this.toServiceInfo(p, !!(await this.apiKey()));
  }

  /**
   * One platform's actions — ALL of them. `important` means nothing here (there is no shortlist to
   * ask for) and `limit` is honoured only when a caller passes one; nothing caps the list by default.
   */
  async listActions(service: string, opts: { important?: boolean; limit?: number; search?: string } = {}): Promise<ServiceAction[]> {
    const gen = await this.ready();
    const s = slugSegment(service);
    const p = gen?.platforms.find((x) => x.slug === s);
    if (!p) return [];
    const q = String(opts.search || '').trim().toLowerCase();
    let out = p.actions.filter((a) => !q || a.id.includes(q) || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q) || (a.tags || []).some((t) => t.toLowerCase().includes(q)));
    if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
    return out;
  }

  async getAction(actionId: string): Promise<ServiceAction | null> {
    const gen = await this.ready();
    return gen?.byId.get(String(actionId || '')) || null;
  }

  /** Is this one of ours? The run path asks before it picks a provider (ids are exact, never guessed). */
  async owns(actionId: string): Promise<boolean> {
    if (!isServiceToolId(actionId)) return false;
    // Cheap answers first, so an unrelated `svc:github.*` step never waits on our first spec read:
    // the list is already here, or there is no key (then nothing here can run anyway).
    if (this.gen) return this.gen.byId.has(actionId);
    if (!(await this.apiKey())) return false;
    const gen = await this.ready();
    return !!gen?.byId.has(actionId);
  }

  /**
   * "Connect" = paste the key. No OAuth, no per-platform login: one key covers every platform, so
   * connecting any one of them connects them all. Without credentials this answers with the
   * `needsCredentials` shape `/tools` already draws; with them it checks the key for real (the
   * balance call) before saving it, so a typo is caught here and not on the first run.
   */
  async connect(service: string, opts: { label?: string; callbackUrl?: string; credentials?: Record<string, any> } = {}): Promise<ConnectResult> {
    const gen = await this.ready();
    const p = gen?.platforms.find((x) => x.slug === slugSegment(service));
    const name = p?.name || 'this platform';
    const key = String(opts.credentials?.apiKey || '').trim();
    if (!key) {
      return {
        ok: false,
        needsCredentials: true,
        fields: [KEY_FIELD],
        message: `Paste your Scrape Creators API key — one key covers ${name} and every other social platform here.`,
      };
    }
    try {
      const credits = await this.creditBalance(key);
      await this.connectors.set(CONNECTOR as any, { apiKey: key });
      this.balance = null;
      return { ok: true, done: true, connectionId: ACCOUNT.id, status: 'ACTIVE', message: `Connected — ${credits.toLocaleString('en-US')} credits on the account.` };
    } catch {
      // Never echo the key or the vendor's body: a rejected key gets a plain sentence.
      return { ok: false, message: 'That key was not accepted. Check it and try again.' };
    }
  }

  /** Dropping the one account drops the key — for every platform, and it says so. */
  async disconnect(connectionId: string): Promise<{ ok: boolean; message?: string }> {
    if (!connectionId) return { ok: false, message: 'No connection given.' };
    try {
      await this.connectors.remove(CONNECTOR as any);
      this.balance = null;
      return { ok: true, message: 'The Scrape Creators key was removed — every social platform is disconnected until a key is added again.' };
    } catch (e: any) {
      return { ok: false, message: this.plainError(e) };
    }
  }

  async renameConnection(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'There is one key for every platform here, and it has no name to change.' };
  }

  /** On demand: forget the balance and re-read the spec in the background. Never blocks a caller. */
  refresh() {
    this.balance = null;
    this.loading = this.loadSpec().catch(() => undefined);
  }

  /**
   * The same, but WAITED for (bounded) — the Social page's "check again" wants the answer after the
   * re-read, not the list from before it (BEA-1356). Never throws; the last good list stays on failure.
   */
  async reload(maxWaitMs = 10_000): Promise<{ ok: boolean; opCount: number; source: string; message?: string }> {
    this.balance = null;
    const p = this.loadSpec().catch((e: any) => ({ ok: false, opCount: this.gen?.opCount || 0, source: this.source, message: String(e?.message || e) }));
    this.loading = p;
    const timeout = new Promise<{ ok: boolean; opCount: number; source: string; message?: string }>((r) => setTimeout(() => r({ ok: false, opCount: this.gen?.opCount || 0, source: this.source, message: 'still reading' }), maxWaitMs).unref?.());
    return Promise.race([p, timeout]);
  }

  /**
   * Run one endpoint: ONE HTTPS call to `https://api.scrapecreators.com<path>` with `x-api-key`.
   * Query arguments go on the URL, path arguments into the path, and for a POST the rest go in the
   * JSON body — exactly as the spec declared them. `credits` is `credits_charged` from the answer.
   * Never throws.
   */
  async execute(actionId: string, args: Record<string, any> = {}, opts: { connectionId?: string; timeoutMs?: number } = {}): Promise<ExecuteResult> {
    const started = Date.now();
    const gen = await this.ready();
    const action = gen?.byId.get(String(actionId || ''));
    const route = gen?.routes.get(String(actionId || ''));
    if (!action || !route) return { ok: false, error: `"${actionId}" is not one of the social endpoints we know.`, ms: Date.now() - started };
    const key = await this.apiKey();
    if (!key) return { ok: false, error: 'Add your Scrape Creators API key in Settings → Connections first.', ms: Date.now() - started };

    try {
      let path = route.path;
      const query: Record<string, any> = {};
      const body: Record<string, any> = {};
      for (const [k, v] of Object.entries(args || {})) {
        if (v === undefined || v === null || v === '') continue;
        if (route.pathParams.includes(k)) path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
        else if (route.body.includes(k) || (route.method !== 'GET' && !route.query.includes(k))) body[k] = v;
        else query[k] = v;
      }
      const r = await this.call(key, route.method, path, query, route.method === 'GET' ? undefined : body, opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : CALL_TIMEOUT_MS);
      const ms = Date.now() - started;
      // The honest cost, from THEM. A cache hit says 0 and 0 is what gets written down.
      const charged = Number(r.body?.credits_charged);
      const credits = Number.isFinite(charged) ? charged : undefined;
      // A refusal can come back HTTP 200 with `success:false`; the status code alone is not the verdict.
      if (!r.ok) {
        // "No posts found" is their empty answer, not a broken one (BEA-1359): `error:"not_found"`
        // (HTTP 404, 0 credits). Said as `notFound` so a job can treat a search that found nothing
        // as an empty source; every other refusal (401/402/429/5xx, any other `success:false`) is
        // still just a failure.
        const notFound = r.body?.error === 'not_found' || (r.status === 404 && r.body?.success === false);
        return { ok: false, error: r.error || 'The service refused that call.', data: r.body, ms, credits, status: r.status, ...(notFound ? { notFound: true } : {}) };
      }
      return { ok: true, data: r.body, ms, credits };
    } catch (e: any) {
      return { ok: false, error: this.plainError(e), ms: Date.now() - started };
    }
  }

  // ---- shapes ------------------------------------------------------------------------------

  private toServiceInfo(p: GeneratedPlatform, connected: boolean): ServiceInfo {
    return {
      slug: p.slug,
      name: p.name,
      category: CATEGORY.name,
      categories: [CATEGORY],
      connected,
      accounts: connected ? [ACCOUNT] : [],
      description: `${p.actions.length} ${p.actions.length === 1 ? 'endpoint' : 'endpoints'} — ${p.tags.join(' · ')}`,
      actionCount: p.actions.length,
      triggerCount: 0,
      managedAuth: false,
      noAuth: false,
      authSchemes: ['API_KEY'],
      authMode: 'API_KEY',
      needs: [KEY_FIELD],
      needsAuthConfig: [],
      needsAccount: [KEY_FIELD],
    };
  }

  // ---- HTTP --------------------------------------------------------------------------------

  private async apiKey(): Promise<string | null> {
    try {
      const saved = await this.connectors?.get?.<{ apiKey?: string }>(CONNECTOR as any);
      const key = saved?.apiKey || process.env.SCRAPECREATORS_API_KEY || '';
      return key.trim() ? key.trim() : null;
    } catch {
      const env = (process.env.SCRAPECREATORS_API_KEY || '').trim();
      return env || null;
    }
  }

  /**
   * One call, with the verdict read from the body as well as the status. Throws only on transport —
   * and a pure transport failure (the `fetch()` promise itself rejects: `ECONNRESET`, `EAI_AGAIN`…)
   * is retried ONCE before it does (BEA-1364). A timeout, any HTTP status and a `success:false`
   * body all mean the call reached them and may have been charged, so those are never retried.
   */
  private async call(key: string, method: string, path: string, query: Record<string, any>, body: any, timeoutMs: number): Promise<{ ok: boolean; status: number; body: any; error?: string }> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, Array.isArray(v) ? v.join(',') : String(v));
    const r = await fetchWithRetry(url.toString(), {
      method,
      headers: { 'x-api-key': key, accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, { timeoutMs });
    const text = await r.text().catch(() => '');
    let parsed: any = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text ? { raw: text.slice(0, 2000) } : undefined; }
    const refused = parsed && typeof parsed === 'object' && parsed.success === false;
    if (!r.ok || refused) {
      const why = parsed?.message || parsed?.error || (typeof parsed?.raw === 'string' ? parsed.raw.slice(0, 200) : '') || `HTTP ${r.status}`;
      return { ok: false, status: r.status, body: parsed, error: this.plainStatus(r.status, String(why)) };
    }
    return { ok: true, status: r.status, body: parsed };
  }

  private plainStatus(status: number, why: string): string {
    if (status === 401 || status === 403) return 'Scrape Creators rejected that API key.';
    if (status === 402) return 'The Scrape Creators account is out of credits.';
    if (status === 429) return 'Scrape Creators is rate-limiting us right now — try again in a minute.';
    return why.slice(0, 300);
  }

  /**
   * Never leak the key or a stack into anything the owner reads. A transport failure names its
   * cause — `fetch failed (ECONNRESET: socket hang up)` — never bare "fetch failed" (BEA-1364).
   */
  private plainError(e: any): string {
    const status = e?.status;
    if (status === 401 || status === 403) return 'Scrape Creators rejected that API key.';
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Scrape Creators did not answer in time.';
    if (isTransportError(e) && e?.message) return describeTransportError(e).slice(0, 200);
    return String(e?.message || 'Could not reach Scrape Creators.').slice(0, 200);
  }
}
