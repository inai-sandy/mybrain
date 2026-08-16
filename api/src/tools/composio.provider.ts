import { Injectable, Logger } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BLOCKED_SERVICES,
  ConnectResult,
  CredentialField,
  ExecuteResult,
  isBlockedService,
  isRiskyAction,
  parseServiceToolId,
  ProviderStatus,
  ServiceAccount,
  ServiceAction,
  ServiceInfo,
  ServiceProvider,
  toolIdFromVendorSlug,
  vendorActionSlug,
} from './service-provider';

/**
 * Composio, behind the ServiceProvider seam (BEA-1345). Design: `specs/TOOLS.md`.
 *
 * Written against Composio's **v3 REST API with plain `fetch`**, not their SDK. `@composio/core`
 * pulls in `openai` and `pusher-js`, and this file needs six read endpoints and three writes — an
 * LLM client inside the tool layer is the last thing an app that routes every model call through
 * its own `LlmService` should carry. Every endpoint used here was verified live on 2026-08-16.
 *
 * Two rules this class exists to keep:
 *  - **Counts are read at run time.** Composio's docs page, marketing page and API all disagree
 *    (docs said GitHub 893 tools, the site said 846, the API says 871). The API wins; nothing here
 *    hard-codes a number.
 *  - **Never throw at the caller.** The catalog must survive a wrong key, a slow network or an
 *    outage with every built-in tool still in it, so every method degrades to empty/false.
 */

const API_BASE = process.env.COMPOSIO_API_BASE || 'https://backend.composio.dev/api/v3';

/**
 * Who the connections belong to, on Composio's side. My Brain is single-owner, so one stable id is
 * the whole tenancy story — a customer's instance holds their own key and their own id. It also
 * keeps stray playground connections (`pg-test-…`) out of our list, because every read filters on it.
 */
const USER_ID = process.env.COMPOSIO_USER_ID || 'mybrain-owner';

/** How long a read is reused before we ask Composio again. The catalog is hit on every page. */
const CACHE_MS = 5 * 60 * 1000;

/** A stop on pagination, so one enormous toolkit can never walk 18 pages on a catalog request. */
const MAX_PAGES = 20;
/**
 * 500, not 100. Verified live: the toolkits endpoint honours it, which turns a walk of all 1,209
 * services from thirteen round trips (~10s, and the owner watching a skeleton) into three (~3s).
 */
const PAGE_SIZE = 500;

/** A ceiling on the in-memory cache, so browsing all 1,209 services cannot pin them all in RAM. */
const MAX_CACHE_ENTRIES = 300;

type Cached<T> = { at: number; value: T };

@Injectable()
export class ComposioProvider implements ServiceProvider {
  private readonly log = new Logger('Composio');
  private readonly cache = new Map<string, Cached<any>>();

  constructor(
    private readonly connectors: ConnectorService,
    private readonly prisma?: PrismaService, // optional + LAST — spec files construct positionally
  ) {}

  // ---- the seam --------------------------------------------------------------------------

  async status(): Promise<ProviderStatus> {
    const key = await this.apiKey();
    if (!key) return { configured: false, reachable: false, message: 'No Composio API key saved yet.' };
    try {
      const r = await this.get('/toolkits', { limit: '1' });
      return { configured: true, reachable: true, serviceCount: Number(r?.total_items) || undefined };
    } catch (e: any) {
      return { configured: true, reachable: false, message: this.plainError(e) };
    }
  }

  /**
   * Services, with their live action/trigger counts and any accounts already connected.
   *
   * `connectedOnly` is what the catalog uses: it turns 1,209 toolkits into the handful the owner
   * actually logged into, which is the difference between one request and thirteen pages.
   */
  async listServices(opts: { connectedOnly?: boolean; search?: string; category?: string; limit?: number } = {}): Promise<ServiceInfo[]> {
    if (!(await this.apiKey())) return [];
    try {
      const accounts = await this.accountsByService();
      if (opts.connectedOnly) {
        const slugs = [...accounts.keys()].filter((s) => !isBlockedService(s));
        const infos = await Promise.all(slugs.map((s) => this.serviceInfo(s, accounts).catch(() => null)));
        return infos.filter(Boolean) as ServiceInfo[];
      }

      const params: Record<string, string> = { limit: String(Math.min(opts.limit || 500, 500)) };
      if (opts.search) params.search = opts.search;
      if (opts.category) params.category = opts.category;
      const items = await this.paged('/toolkits', params, opts.limit || 2000);
      return items
        .filter((t: any) => !isBlockedService(t?.slug))
        .map((t: any) => this.toServiceInfo(t, accounts.get(String(t?.slug).toLowerCase()) || []));
    } catch (e: any) {
      this.log.warn(`listServices failed: ${this.plainError(e)}`);
      return [];
    }
  }

  /**
   * One service, in full — one request, straight at the toolkit, no search involved.
   *
   * The list endpoint's `search` is not semantic (verified: "authenticated user" returns
   * `ACCEPT_A_REPOSITORY_INVITATION` first), so looking a known slug up through it would be both
   * slower and capable of missing the very service asked for.
   */
  async getService(slug: string): Promise<ServiceInfo | null> {
    const s = String(slug || '').toLowerCase();
    if (!s || isBlockedService(s) || !(await this.apiKey())) return null;
    try {
      return await this.serviceInfo(s, await this.accountsByService());
    } catch (e: any) {
      this.log.warn(`getService(${s}) failed: ${this.plainError(e)}`);
      return null;
    }
  }

  /**
   * One service's actions, with the JSON schema an agent fills its arguments from.
   *
   * `important: true` asks Composio for its own shortlist (GitHub 36 of 871, Gmail 13 of 61) — the
   * set worth putting in a picker. The full list stays one call away for execution and search.
   */
  async listActions(service: string, opts: { important?: boolean; limit?: number; search?: string } = {}): Promise<ServiceAction[]> {
    const slug = String(service || '').toLowerCase();
    if (!slug || isBlockedService(slug) || !(await this.apiKey())) return [];
    try {
      const params: Record<string, string> = { toolkit_slug: slug };
      if (opts.important) params.important = 'true';
      if (opts.search) params.search = opts.search;
      const items = await this.paged('/tools', params, opts.limit || 1000);
      return items.map((t: any) => this.toAction(slug, t));
    } catch (e: any) {
      this.log.warn(`listActions(${slug}) failed: ${this.plainError(e)}`);
      return [];
    }
  }

  /**
   * ONE action, fetched exactly, with the schema an agent fills its arguments from (BEA-1347).
   *
   * Straight at `GET /tools/<SLUG>` — never through the list endpoint's `search`, which is not
   * semantic: asked for `GITHUB_GET_THE_AUTHENTICATED_USER` it returns
   * `GITHUB_CREATE_OR_UPDATE_A_SECRET_FOR_THE_AUTHENTICATED_USER` first (verified live 2026-08-16).
   * A step that found its action by searching would run the wrong one and report it as done.
   */
  async getAction(actionId: string): Promise<ServiceAction | null> {
    const parsed = parseServiceToolId(actionId);
    const slug = vendorActionSlug(actionId);
    if (!parsed || !slug || isBlockedService(parsed.service) || !(await this.apiKey())) return null;
    const key = `action:${slug}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    try {
      const t = await this.get(`/tools/${encodeURIComponent(slug)}`);
      const action = t?.slug ? this.toAction(parsed.service, t) : null;
      this.cache.set(key, { at: Date.now(), value: action });
      this.prune();
      return action;
    } catch (e: any) {
      // A 404 is an ANSWER — the action is gone, and worth remembering for a few minutes. A
      // timeout or a rate-limit is not, and caching one would tell the owner for the next five
      // minutes that an action he can see in the catalog no longer exists.
      if (e?.status === 404) { this.cache.set(key, { at: Date.now(), value: null }); this.prune(); }
      this.log.warn(`getAction(${actionId}) failed: ${this.plainError(e)}`);
      return null;
    }
  }

  /**
   * Start a login for a service. Three roads out of here, and which one is taken is decided by the
   * toolkit itself, never guessed:
   *
   *  1. **No sign-in at all** (32 toolkits — Hacker News, the weather). Verified live: Composio
   *     REFUSES to make a login config for one of these ("works without an auth config … use its
   *     tools directly"), so we say it is already usable instead of manufacturing an error.
   *  2. **A ready-made login** (121 toolkits, GitHub among them) — mint a redirect and send the
   *     owner to the provider.
   *  3. **Bring your own app** (the other 1,056, Vercel among them) — ask for the credentials, then
   *     put each one where the vendor actually reads it (see `credentialSplit`).
   */
  async connect(service: string, opts: { label?: string; callbackUrl?: string; credentials?: Record<string, any> } = {}): Promise<ConnectResult> {
    const slug = String(service || '').toLowerCase();
    if (!slug) return { ok: false, message: 'No service given.' };
    if (isBlockedService(slug)) return { ok: false, message: `${slug} is handled inside My Brain — it is not connected through an outside service.` };
    if (!(await this.apiKey())) return { ok: false, message: 'Add your Composio API key in Settings → Connections first.' };

    try {
      const toolkit = await this.toolkit(slug);
      if (!toolkit) return { ok: false, message: `We could not find a service called "${slug}".` };
      const name = toolkit.name || slug;
      const managed = (toolkit.composio_managed_auth_schemes || []).length > 0;
      const split = this.credentialSplit(toolkit);
      const needs = [...split.authConfig, ...split.account];

      // 1. Nothing to sign into.
      if (toolkit.no_auth) return { ok: true, done: true, status: 'ACTIVE', message: `${name} needs no sign-in — it is ready to use.` };

      // 3a. Bring your own app, and we have not been given the details yet.
      if (!managed && !opts.credentials) {
        return {
          ok: false,
          needsCredentials: true,
          fields: needs,
          message: `${name} has no ready-made login — you need your own ${split.account.length && !split.authConfig.length ? 'key from them' : 'app registered with them'} first.`,
        };
      }

      const creds = opts.credentials || {};
      const authConfigCreds = this.pick(creds, split.authConfig);
      const accountCreds = this.pick(creds, split.account);
      const mode = this.authMode(toolkit);
      const authConfigId = await this.ensureAuthConfig(slug, managed, Object.keys(authConfigCreds).length ? authConfigCreds : undefined, toolkit);

      // 3b. A key or token: the account carries the secret, and there is no browser step at all.
      // Verified live — `POST /connected_accounts` is only deprecated for MANAGED OAuth, and it is
      // the one endpoint that takes an API key.
      if (Object.keys(accountCreds).length) {
        const made = await this.post('/connected_accounts', {
          auth_config: { id: authConfigId },
          connection: { user_id: USER_ID, state: { authScheme: mode, val: { status: 'ACTIVE', ...accountCreds } } },
        });
        const id = made?.id || made?.connected_account_id;
        const st = String(made?.status || made?.connectionData?.val?.status || 'ACTIVE').toUpperCase();
        await this.rememberConnection(slug, id, opts.label || name, st);
        this.cache.clear();
        return { ok: true, done: true, connectionId: id, status: st, message: `${name} is connected.` };
      }

      // 2. The redirect road. `POST /connected_accounts` is gone for Composio-managed OAuth — it
      // answers HTTP 400 and points at `/connected_accounts/link`. The link it returns EXPIRES in
      // about 12 minutes, so it is minted on demand here and never cached or stored.
      const created = await this.post('/connected_accounts/link', {
        auth_config_id: authConfigId,
        user_id: USER_ID,
        ...(opts.callbackUrl ? { callback_url: opts.callbackUrl } : {}),
      });

      const connectionId = created?.connected_account_id || created?.id || created?.connectionData?.id;
      const redirectUrl = created?.redirect_url || created?.redirect_uri || created?.connectionData?.val?.redirectUrl;
      const status = String(created?.connectionData?.val?.status || created?.status || 'INITIALIZING').toUpperCase();
      await this.rememberConnection(slug, connectionId, opts.label || name, status);
      this.cache.clear();
      return { ok: true, connectionId, redirectUrl, status };
    } catch (e: any) {
      // With the owner's own key in the request, the vendor's error body can quote the value it
      // rejected — so a failed credentials attempt gets a plain sentence, never an echoed secret.
      if (opts.credentials) return { ok: false, message: 'Those details were not accepted. Check them and try again.' };
      return { ok: false, message: this.plainError(e) };
    }
  }

  /** Rename one account. The label is ours, not the vendor's — it only lives in our own table. */
  async renameConnection(connectionId: string, label: string): Promise<{ ok: boolean; message?: string }> {
    const name = String(label || '').trim().slice(0, 80);
    if (!connectionId) return { ok: false, message: 'No connection given.' };
    if (!name) return { ok: false, message: 'Give the account a name.' };
    try {
      const updated = await this.prisma?.serviceConnection?.updateMany?.({ where: { connectedAccountId: connectionId }, data: { label: name } });
      // A connection made before this row existed (or straight in Composio's own console) has
      // nothing to update — write the row rather than silently dropping the owner's name for it.
      if (!updated?.count) {
        const service = await this.serviceOfConnection(connectionId);
        await this.prisma?.serviceConnection?.upsert?.({
          where: { connectedAccountId: connectionId },
          create: { service: service || 'unknown', connectedAccountId: connectionId, label: name, status: 'ACTIVE' },
          update: { label: name },
        });
      }
      this.cache.clear();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: this.plainError(e) };
    }
  }

  /** Forget what was read a moment ago — used right after a connect, so the page sees the truth. */
  refresh() {
    this.cache.clear();
  }

  async disconnect(connectionId: string): Promise<{ ok: boolean; message?: string }> {
    if (!connectionId) return { ok: false, message: 'No connection given.' };
    if (!(await this.apiKey())) return { ok: false, message: 'No Composio API key saved.' };
    try {
      await this.request('DELETE', `/connected_accounts/${encodeURIComponent(connectionId)}`);
      await this.prisma?.serviceConnection?.deleteMany?.({ where: { connectedAccountId: connectionId } }).catch(() => undefined);
      this.cache.clear();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, message: this.plainError(e) };
    }
  }

  /**
   * Run one action. Takes OUR id (`svc:github.create_issue`) and nothing else — the vendor's slug
   * is worked out here so no caller ever learns it.
   *
   * Deliberately thin: argument filling, the flight recorder and the pause-and-ask gate are later
   * issues (BEA-1347/1348). This is the call they will sit on top of.
   */
  async execute(actionId: string, args: Record<string, any> = {}, opts: { connectionId?: string } = {}): Promise<ExecuteResult> {
    const started = Date.now();
    const parsed = parseServiceToolId(actionId);
    const slug = vendorActionSlug(actionId);
    if (!parsed || !slug) return { ok: false, error: `"${actionId}" is not a service tool id.` };
    if (isBlockedService(parsed.service)) return { ok: false, error: `${parsed.service} is not available as an outside service.` };
    if (!(await this.apiKey())) return { ok: false, error: 'Add your Composio API key in Settings → Connections first.' };

    try {
      const body: Record<string, any> = { arguments: args || {}, user_id: USER_ID };
      if (opts.connectionId) body.connected_account_id = opts.connectionId;
      const r = await this.post(`/tools/execute/${encodeURIComponent(slug)}`, body);
      const ms = Date.now() - started;
      // A FAILED action still comes back HTTP 200 — the verdict is in `successful`, and the reason
      // in `error`. Trusting the status code would report every failure as a success.
      if (r?.successful !== true) return { ok: false, error: r?.error || 'The service refused that call.', data: r?.data, ms };
      await this.touchLastUsed(parsed.service, opts.connectionId);
      return { ok: true, data: r?.data, ms };
    } catch (e: any) {
      return { ok: false, error: this.plainError(e), ms: Date.now() - started };
    }
  }

  // ---- shapes ----------------------------------------------------------------------------

  private toServiceInfo(t: any, accounts: ServiceAccount[]): ServiceInfo {
    const meta = t?.meta || {};
    const cats: any[] = meta.categories || t?.categories || [];
    const split = this.credentialSplit(t);
    return {
      slug: String(t?.slug || '').toLowerCase(),
      name: t?.name || t?.slug || 'Service',
      category: cats[0]?.name || cats[0]?.slug || cats[0]?.id || 'Other',
      categories: cats.map((c) => ({ id: String(c?.id || c?.slug || c?.name || '').toLowerCase(), name: c?.name || c?.id || '' })).filter((c) => c.id),
      connected: accounts.length > 0,
      accounts,
      description: meta.description || undefined,
      logo: meta.logo || undefined,
      actionCount: Number.isFinite(meta.tools_count) ? meta.tools_count : undefined,
      triggerCount: Number.isFinite(meta.triggers_count) ? meta.triggers_count : undefined,
      managedAuth: (t?.composio_managed_auth_schemes || []).length > 0,
      noAuth: !!t?.no_auth,
      authSchemes: t?.auth_schemes || t?.composio_managed_auth_schemes || [],
      authMode: this.authMode(t),
      needs: [...split.authConfig, ...split.account],
      needsAuthConfig: split.authConfig,
      needsAccount: split.account,
    };
  }

  private toAction(service: string, t: any): ServiceAction {
    const slug = String(t?.slug || '');
    return {
      id: toolIdFromVendorSlug(service, slug),
      name: t?.name || slug,
      description: t?.description || '',
      schema: t?.input_parameters || { type: 'object', properties: {} },
      risky: isRiskyAction(slug, service),
      service,
      deprecated: !!t?.is_deprecated,
    };
  }

  /**
   * What the owner must supply when there is no managed login — kept in the two halves the vendor
   * actually reads, because they go to two different calls.
   *
   * Which half is filled depends on the auth style, and both were read off the live API on
   * 2026-08-16: an OAuth service wants its app's client id/secret at **login-config** time
   * (Twitter: `client_id`, `client_secret`, `generic_id`), while a key-based one wants the key at
   * **account** time (Vercel's only required field is `bearer_token`, under
   * `connected_account_initiation`). Pouring both into one bag and posting it to the auth config
   * would leave a key-based service asking for nothing and connecting to nothing.
   */
  private credentialSplit(toolkit: any): { authConfig: CredentialField[]; account: CredentialField[] } {
    const details: any[] = toolkit?.auth_config_details || [];
    const fields = details[0]?.fields || {};
    const half = (raw: any[]): CredentialField[] => {
      const seen = new Set<string>();
      const out: CredentialField[] = [];
      for (const f of raw || []) {
        if (!f?.name || seen.has(f.name)) continue;
        seen.add(f.name);
        out.push({
          name: f.name,
          label: f.displayName || f.name,
          description: f.description || undefined,
          required: f.required !== false,
          // Anything that is plainly a secret gets a password box, not a plain one over the owner's shoulder.
          secret: /secret|token|key|password/i.test(String(f.name)),
        });
      }
      return out;
    };
    const authConfig = half(fields?.auth_config_creation?.required);
    const names = new Set(authConfig.map((f) => f.name));
    return { authConfig, account: half(fields?.connected_account_initiation?.required).filter((f) => !names.has(f.name)) };
  }

  /** OAUTH2 · API_KEY · BEARER_TOKEN … — the vendor's own word for how this service is signed into. */
  private authMode(toolkit: any): string {
    return toolkit?.auth_config_details?.[0]?.mode || (toolkit?.no_auth ? 'NO_AUTH' : toolkit?.auth_schemes?.[0] || 'OAUTH2');
  }

  private pick(values: Record<string, any>, fields: CredentialField[]): Record<string, any> {
    const out: Record<string, any> = {};
    for (const f of fields) {
      const v = values?.[f.name];
      if (v !== undefined && v !== null && String(v).trim() !== '') out[f.name] = v;
    }
    return out;
  }

  private async serviceOfConnection(connectionId: string): Promise<string | null> {
    try {
      const a = await this.get(`/connected_accounts/${encodeURIComponent(connectionId)}`);
      return String(a?.toolkit?.slug || '').toLowerCase() || null;
    } catch {
      return null;
    }
  }

  // ---- Composio reads --------------------------------------------------------------------

  private async toolkit(slug: string): Promise<any | null> {
    return this.cached(`toolkit:${slug}`, async () => {
      try {
        return await this.get(`/toolkits/${encodeURIComponent(slug)}`);
      } catch {
        return null;
      }
    });
  }

  private async serviceInfo(slug: string, accounts: Map<string, ServiceAccount[]>): Promise<ServiceInfo | null> {
    const t = await this.toolkit(slug);
    if (!t) return null;
    return this.toServiceInfo(t, accounts.get(slug) || []);
  }

  /** Every connected account of ours, grouped by service. Other users' accounts are filtered out. */
  private async accountsByService(): Promise<Map<string, ServiceAccount[]>> {
    return this.cached('accounts', async () => {
      const map = new Map<string, ServiceAccount[]>();
      const rows = await this.paged('/connected_accounts', { user_ids: USER_ID }, 500).catch(() => [] as any[]);
      const labels = await this.savedLabels();
      for (const a of rows) {
        const slug = String(a?.toolkit?.slug || '').toLowerCase();
        if (!slug) continue;
        const saved = labels.get(a?.id);
        const list = map.get(slug) || [];
        list.push({
          id: a?.id,
          label: saved?.label || a?.alias || a?.word_id || `${slug} account`,
          status: String(a?.status || 'ACTIVE').toUpperCase(),
          connectedAt: a?.created_at || saved?.connectedAt,
          lastUsedAt: saved?.lastUsedAt,
        });
        map.set(slug, list);
      }
      return map;
    });
  }

  // ---- our own record of a connection ----------------------------------------------------

  private async savedLabels(): Promise<Map<string, { label?: string; connectedAt?: string; lastUsedAt?: string }>> {
    const out = new Map<string, { label?: string; connectedAt?: string; lastUsedAt?: string }>();
    try {
      const rows = (await this.prisma?.serviceConnection?.findMany?.()) || [];
      for (const r of rows as any[]) {
        out.set(r.connectedAccountId, {
          label: r.label || undefined,
          connectedAt: r.connectedAt?.toISOString?.(),
          lastUsedAt: r.lastUsedAt?.toISOString?.(),
        });
      }
    } catch {
      /* the catalog must not care that our own table is unreadable */
    }
    return out;
  }

  private async rememberConnection(service: string, connectedAccountId: string, label: string, status: string) {
    if (!connectedAccountId) return;
    try {
      await this.prisma?.serviceConnection?.upsert?.({
        where: { connectedAccountId },
        create: { service, connectedAccountId, label, status },
        update: { label, status },
      });
    } catch (e: any) {
      this.log.warn(`could not record the ${service} connection: ${e?.message || e}`);
    }
  }

  private async touchLastUsed(service: string, connectionId?: string) {
    try {
      const where = connectionId ? { connectedAccountId: connectionId } : { service };
      await this.prisma?.serviceConnection?.updateMany?.({ where, data: { lastUsedAt: new Date() } });
    } catch {
      /* a missing timestamp must never fail a tool call */
    }
  }

  // ---- auth configs ----------------------------------------------------------------------

  /**
   * Reuse the service's login config if one exists, else make one.
   *
   * `credentials` here means **the login config's own** credentials (an OAuth app's client id and
   * secret) — never an API key, which belongs to the account and is passed by `connect()` instead.
   * When the owner supplies fresh app credentials we always make a new config, because the old one
   * holds the old secret; otherwise reusing is right, and stops a second account of the same
   * service leaving a trail of near-identical configs behind it.
   */
  private async ensureAuthConfig(slug: string, managed: boolean, credentials: Record<string, any> | undefined, toolkit: any): Promise<string> {
    if (!credentials) {
      const existing = await this.get('/auth_configs', { toolkit_slug: slug, limit: '1' }).catch(() => null);
      const found = existing?.items?.[0]?.id;
      if (found) return found;
    }
    const authScheme = this.authMode(toolkit);
    const name = `mybrain-${slug}`;
    // Without a ready-made login every config is one of ours — even a key-based service, whose
    // config carries no secret at all (verified live: `credentials: {}` is accepted).
    const custom = !managed || !!credentials;
    const wanted = this.credentialSplit(toolkit).authConfig;
    if (custom && wanted.length && !credentials) throw new Error(`${toolkit?.name || slug} needs your own app details first.`);
    const body = custom
      ? { toolkit: { slug }, auth_config: { type: 'use_custom_auth', name, authScheme, credentials: credentials || {} } }
      : { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth', name } };
    const created = await this.post('/auth_configs', body);
    const id = created?.auth_config?.id;
    if (!id) throw new Error('Composio did not return a login config.');
    return id;
  }

  // ---- HTTP ------------------------------------------------------------------------------

  private async apiKey(): Promise<string | null> {
    try {
      const saved = await this.connectors?.get?.<{ apiKey?: string }>('composio' as any);
      const key = saved?.apiKey || process.env.COMPOSIO_API_KEY || '';
      return key.trim() ? key.trim() : null;
    } catch {
      const env = (process.env.COMPOSIO_API_KEY || '').trim();
      return env || null;
    }
  }

  private async request(method: string, path: string, opts: { params?: Record<string, string>; body?: any } = {}): Promise<any> {
    const key = await this.apiKey();
    if (!key) throw new Error('No Composio API key saved.');
    const url = new URL(`${API_BASE}${path}`);
    for (const [k, v] of Object.entries(opts.params || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const r = await fetch(url.toString(), {
      method,
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw Object.assign(new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`), { status: r.status });
    }
    return r.status === 204 ? {} : r.json();
  }

  private get(path: string, params?: Record<string, string>) {
    return this.request('GET', path, { params });
  }

  private post(path: string, body: any) {
    return this.request('POST', path, { body });
  }

  /** Walk Composio's cursor pagination, with a hard stop. */
  private async paged(path: string, params: Record<string, string>, max: number): Promise<any[]> {
    const key = `${path}?${JSON.stringify(params)}|${max}`;
    return this.cached(key, async () => {
      const out: any[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES && out.length < max; page++) {
        const r = await this.get(path, { ...params, limit: String(Math.min(PAGE_SIZE, max - out.length)), ...(cursor ? { cursor } : {}) });
        const items: any[] = r?.items || [];
        out.push(...items);
        cursor = r?.next_cursor || undefined;
        if (!cursor || items.length === 0) break;
      }
      return out.slice(0, max);
    });
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await load();
    this.cache.set(key, { at: Date.now(), value });
    this.prune();
    return value;
  }

  /**
   * Drop what has gone stale, and cap what is left.
   *
   * There are 1,209 services, so a browse of the whole list would otherwise leave 1,209 toolkit
   * payloads sitting in memory in a long-running container for ever.
   */
  private prune() {
    const now = Date.now();
    for (const [k, v] of this.cache) if (now - v.at >= CACHE_MS) this.cache.delete(k);
    while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
  }

  /** Never leak the key or a stack into anything the owner reads. */
  private plainError(e: any): string {
    const status = e?.status;
    if (status === 401 || status === 403) return 'Composio rejected that API key.';
    if (status === 404) return 'Composio does not know that service or action.';
    if (status === 429) return 'Composio is rate-limiting us right now — try again in a minute.';
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Composio did not answer in time.';
    return String(e?.message || 'Could not reach Composio.').slice(0, 200);
  }

  /** Exposed for the catalog's own guard rails and for tests. */
  static readonly blocked = BLOCKED_SERVICES;
}
