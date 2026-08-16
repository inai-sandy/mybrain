import { Injectable, Logger } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BLOCKED_SERVICES,
  ConnectResult,
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
const PAGE_SIZE = 100;

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
   * Start a login for a service.
   *
   * Not every toolkit ships Composio-managed auth — Vercel returns an empty
   * `composio_managed_auth_schemes`, which means the owner has to register their own OAuth app and
   * paste its client id/secret. We say so instead of handing back a one-click URL that cannot work.
   */
  async connect(service: string, opts: { label?: string; callbackUrl?: string; credentials?: Record<string, any> } = {}): Promise<ConnectResult> {
    const slug = String(service || '').toLowerCase();
    if (!slug) return { ok: false, message: 'No service given.' };
    if (isBlockedService(slug)) return { ok: false, message: `${slug} is handled inside My Brain — it is not connected through an outside service.` };
    if (!(await this.apiKey())) return { ok: false, message: 'Add your Composio API key in Settings → Connections first.' };

    try {
      const toolkit = await this.toolkit(slug);
      if (!toolkit) return { ok: false, message: `We could not find a service called "${slug}".` };
      const managed = (toolkit.composio_managed_auth_schemes || []).length > 0;
      const needs = this.credentialFields(toolkit);

      if (!managed && !toolkit.no_auth && !opts.credentials) {
        return {
          ok: false,
          needsCredentials: true,
          fields: needs,
          message: `${toolkit.name || slug} has no ready-made login — you need to register your own app with them and paste its details here.`,
        };
      }

      const authConfigId = await this.ensureAuthConfig(slug, managed, opts.credentials, toolkit);

      // `/connected_accounts` (POST) is gone for Composio-managed OAuth — it answers HTTP 400 and
      // points at `/connected_accounts/link`. The link it returns EXPIRES in about 12 minutes, so
      // it is minted on demand here and never cached or stored.
      const created = await this.post('/connected_accounts/link', {
        auth_config_id: authConfigId,
        user_id: USER_ID,
        ...(opts.callbackUrl ? { callback_url: opts.callbackUrl } : {}),
      });

      const connectionId = created?.connected_account_id || created?.id || created?.connectionData?.id;
      const redirectUrl = created?.redirect_url || created?.redirect_uri || created?.connectionData?.val?.redirectUrl;
      const status = String(created?.connectionData?.val?.status || created?.status || 'INITIALIZING').toUpperCase();
      await this.rememberConnection(slug, connectionId, opts.label || toolkit.name || slug, status);
      this.cache.clear();
      return { ok: true, connectionId, redirectUrl, status };
    } catch (e: any) {
      return { ok: false, message: this.plainError(e) };
    }
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
    return {
      slug: String(t?.slug || '').toLowerCase(),
      name: t?.name || t?.slug || 'Service',
      category: cats[0]?.name || cats[0]?.slug || cats[0]?.id || 'Other',
      connected: accounts.length > 0,
      accounts,
      description: meta.description || undefined,
      logo: meta.logo || undefined,
      actionCount: Number.isFinite(meta.tools_count) ? meta.tools_count : undefined,
      triggerCount: Number.isFinite(meta.triggers_count) ? meta.triggers_count : undefined,
      managedAuth: (t?.composio_managed_auth_schemes || []).length > 0,
      noAuth: !!t?.no_auth,
      authSchemes: t?.auth_schemes || t?.composio_managed_auth_schemes || [],
      needs: this.credentialFields(t),
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
   * What the owner must supply when there is no managed login for a service.
   *
   * Both halves matter, and which one is filled depends on the auth style: an OAuth service asks
   * for its app's client id/secret under `auth_config_creation` (GitHub), while a key-based one
   * asks for the key itself under `connected_account_initiation` — Vercel's only required field is
   * `bearer_token`, and reading just the first half would have told the owner "nothing needed".
   */
  private credentialFields(toolkit: any): { name: string; label: string; description?: string; required?: boolean }[] {
    const details: any[] = toolkit?.auth_config_details || [];
    const fields = details[0]?.fields || {};
    const raw: any[] = [...(fields?.auth_config_creation?.required || []), ...(fields?.connected_account_initiation?.required || [])];
    const seen = new Set<string>();
    const out: { name: string; label: string; description?: string; required?: boolean }[] = [];
    for (const f of raw) {
      if (!f?.name || seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({ name: f.name, label: f.displayName || f.name, description: f.description || undefined, required: f.required !== false });
    }
    return out;
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

  /** Reuse the service's auth config if one exists, else make one. */
  private async ensureAuthConfig(slug: string, managed: boolean, credentials: Record<string, any> | undefined, toolkit: any): Promise<string> {
    if (!credentials) {
      const existing = await this.get('/auth_configs', { toolkit_slug: slug, limit: '1' }).catch(() => null);
      const found = existing?.items?.[0]?.id;
      if (found) return found;
    }
    const authScheme = toolkit?.auth_config_details?.[0]?.mode || (toolkit?.no_auth ? 'NO_AUTH' : 'OAUTH2');
    const name = `mybrain-${slug}`;
    const body = credentials
      ? { toolkit: { slug }, auth_config: { type: 'use_custom_auth', name, authScheme, credentials } }
      : { toolkit: { slug }, auth_config: { type: 'use_composio_managed_auth', name } };
    if (!managed && !credentials && !toolkit?.no_auth) throw new Error(`${slug} needs your own app credentials.`);
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
