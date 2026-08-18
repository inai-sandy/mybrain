import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { sendJson } from '../common/send-json';
import { ComposioProvider } from './composio.provider';
import { ServiceGatesService } from './service-gates.service';
import { ServiceInfo } from './service-provider';

/**
 * The `/tools` page's own endpoints (BEA-1346).
 *
 * It talks to the **seam**, never to a vendor — `ComposioProvider` is injected as the one
 * implementation of `ServiceProvider` that exists today, and nothing in here knows a vendor's name,
 * its URLs or its field names. Swapping the provider swaps this page with it.
 *
 * One shape rule worth keeping: the browse list carries 1,209 services in a single answer, so every
 * row is trimmed to what a card actually draws. The heavy half (what credentials a service wants,
 * every auth scheme it offers) is one request away on `GET /:slug`, which the page makes only when
 * the owner opens a service. The whole list is ~320KB; a fat one would be over a megabyte.
 */

/** One row of the browse list — exactly what a card draws, and nothing else. */
type ServiceRow = {
  slug: string;
  name: string;
  category: string;
  categories: string[];
  description?: string;
  logo?: string;
  actionCount?: number;
  triggerCount?: number;
  managedAuth?: boolean;
  noAuth?: boolean;
  connected: boolean;
  accounts: { id: string; label: string; status: string; connectedAt?: string; lastUsedAt?: string }[];
  /** How many things the owner has to type in when there is no ready-made login. */
  needsCount: number;
};

/**
 * Category names come back in whatever case the vendor happened to store — "Other / Miscellaneous"
 * next to "developer tools" next to "crm". Only the all-lowercase ones are touched, so a name that
 * was written properly is never mangled.
 */
const ACRONYMS = new Set(['ai', 'crm', 'erp', 'hr', 'it', 'sms', 'seo', 'api', 'ui', 'ux', 'saas', 'b2b', 'b2c', 'pdf', 'mcp', 'iot', 'cms', 'cdn', 'sdk', 'llm', 'rss', 'voip', 'cx', 'hcm', 'pos']);

function tidy(name: string): string {
  const s = String(name || '').trim();
  if (!s) return 'Other';
  if (s !== s.toLowerCase()) return s;
  return s
    .split(' ')
    // "crm" is a word the owner reads a hundred times a day — printing it "Crm" makes a real
    // product look like a typo.
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

@Controller('tools/services')
export class ServicesController {
  private readonly log = new Logger('Services');

  constructor(
    private readonly services: ComposioProvider,
    // Optional + LAST — the spec builds this controller with the provider alone.
    private readonly gates?: ServiceGatesService,
  ) {}

  /**
   * Everything the browse page needs in one answer: whether the key works, every service, and the
   * categories built from the services themselves.
   *
   * The categories deliberately are NOT read from the vendor's own category endpoint — it answers
   * with duplicates and with names that no toolkit is filed under, so a filter built from it would
   * offer choices that return nothing. Counting what the services actually say cannot drift.
   */
  @Get()
  async listRoute(@Res() res: Response, @Query('refresh') refresh?: string) {
    sendJson(res, await this.list(refresh));
  }

  /** The answer itself, with no HTTP in it — the route above only decides how to put it on the wire. */
  async list(refresh?: string) {
    if (refresh) this.services.refresh();
    const status = await this.services.status();
    if (!status.configured || !status.reachable) return { status, services: [], categories: [], connectedCount: 0 };

    const all = await this.services.listServices();
    const counts = new Map<string, { id: string; label: string; count: number }>();
    for (const s of all) {
      for (const c of s.categories || []) {
        const at = counts.get(c.id) || { id: c.id, label: tidy(c.name), count: 0 };
        at.count += 1;
        counts.set(c.id, at);
      }
    }
    return {
      status,
      connectedCount: all.filter((s) => s.connected).length,
      categories: [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
      services: all.map((s) => this.row(s)),
    };
  }

  /** One service in full — the half the list leaves out, fetched when a service is opened. */
  @Get(':slug')
  async one(@Param('slug') slug: string, @Query('refresh') refresh?: string) {
    if (refresh) this.services.refresh();
    const service = await this.services.getService(String(slug || ''));
    if (!service) return { service: null, message: `We could not find a service called "${slug}".` };
    // For a connected service, the number the sheet shows is the number of actions the owner's
    // agents can really pick (BEA-1354: the whole list — and since BEA-1365 that INCLUDES what the
    // vendor has retired, tagged; `retiredActionCount` says how many) — read from the same cached
    // walk the catalog is built from, so it cannot disagree with the picker.
    let availableActionCount: number | undefined;
    let retiredActionCount: number | undefined;
    if (service.connected) {
      const actions = await this.services.listActions(service.slug).catch(() => []);
      if (actions.length) {
        availableActionCount = actions.length;
        retiredActionCount = actions.filter((a) => a.retired).length;
      }
    }
    return {
      service: {
        ...service,
        category: tidy(service.category),
        ...(availableActionCount !== undefined ? { availableActionCount, retiredActionCount } : {}),
      },
    };
  }

  /**
   * Start (or finish) a login.
   *
   * Three answers are all normal and the page draws each one differently: a `redirectUrl` to send
   * the owner to, `needsCredentials` with the fields to ask for, or `done` when there was nothing
   * to sign into. The redirect expires in about twelve minutes, so it is minted on this click and
   * never stored anywhere.
   */
  @Post(':slug/connect')
  async connect(@Param('slug') slug: string, @Body() body: { label?: string; credentials?: Record<string, any> }) {
    const r = await this.services.connect(String(slug || ''), { label: body?.label, credentials: body?.credentials });
    if (r.ok) this.services.refresh();
    // Never log the body — it can carry the owner's own client secret or API key.
    this.log.log(`connect ${slug}: ${r.ok ? (r.done ? 'done' : 'sent to sign in') : r.needsCredentials ? 'needs credentials' : 'refused'}`);
    return r;
  }

  /**
   * The gated actions of one service, and which of them the owner has released (BEA-1348).
   *
   * Two segments, so it never collides with `GET /:slug` above.
   */
  @Get(':slug/gates')
  async gatesFor(@Param('slug') slug: string) {
    if (!this.gates) return { service: String(slug || ''), actions: [] };
    return this.gates.listForService(String(slug || ''));
  }

  /**
   * Turn one gate off for good, or put it back. Per service — never per agent, so there is one
   * answer to "does this ask me?" wherever it runs from.
   */
  @Post(':slug/gates')
  async setGate(@Param('slug') slug: string, @Body() body: { action?: string; released?: boolean }) {
    const action = String(body?.action || '');
    if (!this.gates) return { ok: false, message: 'Gates are not available on this server.' };
    if (!action.toLowerCase().startsWith(`svc:${String(slug || '').toLowerCase()}.`)) {
      return { ok: false, message: 'That action does not belong to this service.' };
    }
    return body?.released ? this.gates.release(action) : this.gates.restore(action);
  }

  /** Give one account a name the owner recognises ("work gmail"). */
  @Patch('connections/:id')
  rename(@Param('id') id: string, @Body() body: { label?: string }) {
    return this.services.renameConnection(String(id || ''), String(body?.label || ''));
  }

  /** Drop one account. The page confirms first. */
  @Delete('connections/:id')
  async disconnect(@Param('id') id: string) {
    const r = await this.services.disconnect(String(id || ''));
    if (r.ok) this.services.refresh();
    return r;
  }

  private row(s: ServiceInfo): ServiceRow {
    return {
      slug: s.slug,
      name: s.name,
      category: tidy(s.category),
      categories: (s.categories || []).map((c) => c.id),
      // Trimmed on purpose: a card shows two lines, and the untrimmed set is another 40KB on a phone.
      description: s.description ? String(s.description).slice(0, 180) : undefined,
      logo: s.logo,
      actionCount: s.actionCount,
      triggerCount: s.triggerCount,
      managedAuth: s.managedAuth,
      noAuth: s.noAuth,
      connected: s.connected,
      accounts: s.accounts || [],
      needsCount: (s.needs || []).length,
    };
  }
}
