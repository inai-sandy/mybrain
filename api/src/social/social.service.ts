import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey, TZ_OFFSET_MIN } from '../common/localday';
import { ScrapeCreatorsProvider } from '../tools/scrapecreators.provider';
import { WhatsAppProvider, WHATSAPP_SERVICE } from '../tools/whatsapp.provider';
import { ServiceActionsService, ServiceCallContext, ServiceRunResult } from '../tools/service-actions.service';
import { GatePause, PendingGate } from '../tools/service-gates.service';
import { ServiceAction, ServiceInfo } from '../tools/service-provider';

/**
 * The Social section's own answers (BEA-1356) — design: `specs/SOCIAL.md`.
 *
 * Everything the three screens draw comes from here, and this file adds NO knowledge of its own:
 * the platforms are `provider.listServices()`, the endpoints are `provider.listActions()`, both
 * generated from the vendor's spec (never a hand list, so the counts on the page ARE the provider's
 * counts); a run goes through the ONE run path, `ServiceActionsService.runDetailed()`, so the
 * `ToolCall` row with its `credits` is written exactly as it is for an agent or a flow — there is
 * deliberately no second place that calls `execute()`.
 *
 * "Today's spend" is the sum of `ToolCall.credits` since the owner's local midnight, over the
 * social platforms only. The daily ceiling (`social.dailyCreditCeiling`, default 500) is READ here
 * and shown; it is set in Settings and enforced before every job's call by `SocialBudgetService`.
 */

/** The Setting key the daily ceiling lives under (BEA-1358) — set in Settings, enforced by `SocialBudgetService`. */
export const CEILING_KEY = 'social.dailyCreditCeiling';
/** The ceiling when the owner has never set one. 0 (or blank) = no limit. */
export const CEILING_DEFAULT = 500;

/** Where to top up. Shown when the provider answers 402 — never a raw error. */
export const TOP_UP_URL = 'https://scrapecreators.com';

/**
 * The vendor's own "platforms" that are not social platforms (BEA-1365): `account` is their
 * balance/usage endpoints, and the header already shows balance and spend. The grid leaves these
 * out; the provider and the catalog still own `svc:account.*` — nothing is removed from the seam,
 * this is a display choice made here and nowhere else.
 */
export const VENDOR_PLATFORMS = new Set(['account']);
/** The platforms the grid draws — the provider's list minus the vendor's own. */
export const isGridPlatform = (s: { slug: string }) => !VENDOR_PLATFORMS.has(String(s.slug || '').toLowerCase());

/** One platform as the grid draws it. */
export type SocialPlatform = {
  slug: string;
  name: string;
  actionCount: number;
  /** The spec's own groups for this platform ("TikTok", "TikTok Shop"). Biggest first. */
  tags: string[];
  /** What kinds of endpoint it has — for the grid's filter (`profile`, `posts`, `search`…). */
  kinds: string[];
  description?: string;
  connected: boolean;
  /**
   * FALSE when this platform's provider does not charge credits (WhatsApp, BEA-1384) — the pages
   * then hide the credit strip and the per-run cost chips instead of saying "cached · 0".
   */
  metered?: boolean;
};

/** How one platform's OWN provider stands — for a platform that is not on the scraping key (BEA-1384). */
export type PlatformConnection = { configured: boolean; message?: string };

/** The gate as the Social page draws it: the question, plus the keys the answer must echo back. */
export type SocialGate = PendingGate & { runId: string; nodeId: string; options: string[] };

export type SocialOverview = {
  status: { configured: boolean; reachable: boolean; message?: string };
  balance: number | null;
  spentToday: number;
  ceiling: number | null;
  platforms: SocialPlatform[];
  spec: { source: string; generatedAt?: string; opCount: number; platformCount: number; lastError?: string };
  topUpUrl: string;
};

/** What the run route answers. `data` is the provider's whole envelope; `gate` = stopped to ask (BEA-1384). */
export type SocialRunResult = ServiceRunResult & { topUpUrl?: string; gate?: SocialGate };

/**
 * The words the grid can filter platforms by, matched against the endpoint half of each id.
 * Not a taxonomy of ours — just the words that appear in their paths, so no option can come back
 * empty for a platform that has such an endpoint.
 */
const KIND_WORDS: [string, RegExp][] = [
  ['profile', /profile|user_info|channel|about|account/],
  ['posts', /post|video|reel|tweet|photo|story|stories|thread/],
  ['comments', /comment|repl/],
  ['transcript', /transcript|caption/],
  ['search', /search|hashtag|trending|explore/],
  ['ads', /ad_library|_ads?\b|ads_/],
  ['followers', /follow|subscri|audience|demograph/],
];

@Injectable()
export class SocialService {
  constructor(
    private readonly social: ScrapeCreatorsProvider,
    private readonly actions: ServiceActionsService,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly prisma?: PrismaService,
    // WhatsApp, the third provider on the seam (BEA-1384) — one more platform on the same grid.
    private readonly whatsapp?: WhatsAppProvider,
  ) {}

  /** The grid page in one answer: key state, balance, today's spend, the ceiling, every platform. */
  async overview(refresh = false): Promise<SocialOverview> {
    // Waited for (bounded): "check again" must answer with the list AFTER the re-read, not before.
    if (refresh) await this.social.reload?.().catch(() => undefined);
    const [status, services] = await Promise.all([
      this.social.status().catch((e: any) => ({ configured: false, reachable: false, message: String(e?.message || e) })),
      this.social.listServices().catch(() => [] as ServiceInfo[]),
    ]);
    // The grid is the provider's list minus the vendor's own `account` (BEA-1365); spend is still
    // summed over EVERY platform the provider has, so the header's numbers do not move.
    const platforms = await Promise.all(services.filter(isGridPlatform).map((s) => this.platformRow(s)));
    // WhatsApp rides on the same grid from its own provider (BEA-1384) — shown even when its
    // token is missing, honestly marked not connected, so the owner can see what it would offer.
    const wa = await this.whatsappRow();
    if (wa) platforms.push(wa);
    const [balance, spentToday, ceiling] = await Promise.all([
      status.configured && status.reachable ? this.social.creditBalance().catch(() => null) : Promise.resolve(null),
      this.spentToday(services.map((s) => s.slug)),
      this.ceiling(),
    ]);
    return {
      status: { configured: !!status.configured, reachable: !!status.reachable, message: status.message },
      balance,
      spentToday,
      ceiling,
      platforms,
      spec: this.social.specState(),
      topUpUrl: TOP_UP_URL,
    };
  }

  /** The three numbers on their own — re-read after a run, without re-listing every platform. */
  async spend(): Promise<{ status: SocialOverview['status']; balance: number | null; spentToday: number; ceiling: number | null; topUpUrl: string }> {
    const status = await this.social.status().catch((e: any) => ({ configured: false, reachable: false, message: String(e?.message || e) }));
    const services = await this.social.listServices().catch(() => [] as ServiceInfo[]);
    const [balance, spentToday, ceiling] = await Promise.all([
      status.configured && status.reachable ? this.social.creditBalance().catch(() => null) : Promise.resolve(null),
      this.spentToday(services.map((s) => s.slug)),
      this.ceiling(),
    ]);
    return { status: { configured: !!status.configured, reachable: !!status.reachable, message: status.message }, balance, spentToday, ceiling, topUpUrl: TOP_UP_URL };
  }

  /**
   * One platform and EVERY endpoint it has, with the schema each form is generated from. Null
   * when there is no such platform (a typed URL, or one the spec dropped).
   */
  async platform(slug: string): Promise<{ platform: SocialPlatform; actions: ServiceAction[]; connection?: PlatformConnection } | null> {
    // WhatsApp is its own provider (BEA-1384): its page carries the provider's OWN connection
    // state, so the scraping key being missing can never grey out a configured WhatsApp — and
    // the other way round.
    if (String(slug || '').toLowerCase() === WHATSAPP_SERVICE && this.whatsapp) {
      const platform = await this.whatsappRow();
      if (!platform) return null;
      const actions = await this.whatsapp.listActions(WHATSAPP_SERVICE).catch(() => [] as ServiceAction[]);
      const status = await this.whatsapp.status().catch(() => ({ configured: false, reachable: false, message: 'WhatsApp could not be checked just now.' }));
      return { platform, actions, connection: { configured: !!status.configured, message: status.message } };
    }
    const info = await this.social.getService(String(slug || '')).catch(() => null);
    if (!info) return null;
    const actions = await this.social.listActions(info.slug).catch(() => [] as ServiceAction[]);
    const platform = await this.platformRow(info, actions);
    // The response example is the spec's, not the page's: 29 of them make TikTok's answer 200KB+
    // on a phone, and the page draws what actually comes back from a run instead.
    return { platform, actions: actions.map(({ responseExample, ...a }) => a) };
  }

  /**
   * Run one endpoint with the arguments the owner typed into the form — through the ONE run path,
   * so a `ToolCall` row with `credits` is written exactly as for an agent (`runKind: 'social'`).
   *
   * The arguments are pinned (`argsPinned`), so the model is never asked to fill anything: the form
   * IS the answer, blanks included. Required fields are checked here first, in plain words, so a
   * missing handle is a sentence on the form and not a refusal from the far end.
   */
  async run(actionId: string, args: Record<string, any> = {}): Promise<SocialRunResult> {
    const id = String(actionId || '').trim();
    const isWhatsApp = !!this.whatsapp?.owns?.(id);
    if (!isWhatsApp && !(await this.social.owns(id).catch(() => false))) {
      return { ok: false, error: 'That is not one of the social endpoints we know. Reload the page and pick it again.' };
    }
    const action = isWhatsApp
      ? await this.whatsapp!.getAction(id).catch(() => null)
      : await this.social.getAction(id).catch(() => null);
    const clean = this.cleanArgs(args, action);
    const missing = this.missingRequired(clean, action);
    if (missing.length) {
      return { ok: false, error: `Fill in ${missing.join(', ')} first — ${action?.name || 'this endpoint'} needs ${missing.length === 1 ? 'it' : 'them'}.` };
    }
    // The run/step pair the gate's answer will point back at (BEA-1384): one fresh id per press of
    // Run, so an approval is spent on exactly this attempt and can never bless tomorrow's.
    const ctx: ServiceCallContext = { runKind: 'social', runId: `social-${randomUUID()}`, nodeId: id, args: clean, argsPinned: true, label: action?.name };
    try {
      const r = await this.actions.runDetailed(id, '', ctx);
      // 402 = out of credits. The owner gets a sentence and a place to top up, never the raw refusal.
      if (!r.ok && r.outOfCredits) {
        return { ...r, error: 'Your Scrape Creators credits are out. Top up, then run it again.', topUpUrl: TOP_UP_URL };
      }
      return r;
    } catch (e: any) {
      // A send stopped at the can't-undo gate (BEA-1348): not a failure — a question. The page
      // draws it with Run / Cancel, and the answer comes back through `answerGate()` below.
      if (e instanceof GatePause || e?.name === 'GatePause') {
        const gate: PendingGate = e.gate;
        return { ok: false, error: e.message, gate: { ...gate, runId: ctx.runId!, nodeId: ctx.nodeId!, options: ['Yes, send it', 'No, stop'] } };
      }
      return { ok: false, error: String(e?.message || e).slice(0, 400) };
    }
  }

  /**
   * The owner answered a gate on the Social page (BEA-1384). A no records the refusal and runs
   * nothing; a yes records the approval and re-runs the step with the SAME run/step pair, which is
   * how `ServiceActionsService` finds the approval and re-uses the EXACT arguments he was shown —
   * the same contract Chat's confirm card keeps.
   */
  async answerGate(gate: SocialGate, answer: string): Promise<SocialRunResult> {
    const id = String(gate?.actionId || '').trim();
    if (!id || !gate?.runId || !gate?.nodeId) return { ok: false, error: 'That confirm card is incomplete — run it again from the form.' };
    const ctx: ServiceCallContext = { runKind: 'social', runId: gate.runId, nodeId: gate.nodeId, label: gate.actionName };
    const said = await this.actions.answerGate(gate, answer, ctx).catch((e: any) => ({ approved: false, message: String(e?.message || e) }));
    if (!said.approved) return { ok: false, error: said.message };
    try {
      return await this.actions.runDetailed(id, '', { ...ctx, args: gate.args, argsPinned: true });
    } catch (e: any) {
      return { ok: false, error: String(e?.message || e).slice(0, 400) };
    }
  }

  // ---- pieces ------------------------------------------------------------------------------

  /**
   * The WhatsApp tile (BEA-1384): its own provider, its own connection state, and `metered:false`
   * because the gateway charges no credits — the pages then skip the credit strip and cost chips.
   */
  private async whatsappRow(): Promise<SocialPlatform | null> {
    if (!this.whatsapp) return null;
    const info = (await this.whatsapp.listServices().catch(() => [] as ServiceInfo[]))[0];
    if (!info) return null;
    const actions = await this.whatsapp.listActions(WHATSAPP_SERVICE).catch(() => [] as ServiceAction[]);
    // The doc's own groups, biggest first — the platform page groups by the same tags.
    const counts = new Map<string, number>();
    for (const a of actions) for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts.keys()].sort((x, y) => counts.get(y)! - counts.get(x)! || x.localeCompare(y));
    return {
      slug: info.slug,
      name: info.name,
      actionCount: actions.length || (Number.isFinite(info.actionCount) ? Number(info.actionCount) : 0),
      tags,
      kinds: ['messages', 'templates'],
      description: info.description,
      connected: !!info.connected,
      metered: false,
    };
  }

  private async platformRow(s: ServiceInfo, actions?: ServiceAction[]): Promise<SocialPlatform> {
    const list = actions || (await this.social.listActions(s.slug).catch(() => [] as ServiceAction[]));
    // The spec's tags, biggest group first — the same order the platform page groups by.
    const counts = new Map<string, number>();
    for (const a of list) for (const t of a.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const tags = [...counts.keys()].sort((x, y) => counts.get(y)! - counts.get(x)! || x.localeCompare(y));
    const endpoints = list.map((a) => a.id.slice(a.id.indexOf('.') + 1)).join(' ');
    const kinds = KIND_WORDS.filter(([, re]) => re.test(endpoints)).map(([k]) => k);
    return {
      slug: s.slug,
      name: s.name,
      actionCount: Number.isFinite(s.actionCount) ? Number(s.actionCount) : list.length,
      tags,
      kinds,
      description: s.description,
      connected: !!s.connected,
    };
  }

  /**
   * Credits spent since the owner's local midnight, over the social platforms only — the sum of
   * what the provider actually charged (`ToolCall.credits`, never assumed). Composio rows carry
   * null there and a `service` outside this list, so neither can leak into the number.
   */
  async spentToday(platformSlugs: string[], now: Date = new Date()): Promise<number> {
    if (!platformSlugs.length) return 0;
    const midnight = new Date(new Date(`${localDayKey(now)}T00:00:00Z`).getTime() - TZ_OFFSET_MIN * 60000);
    try {
      const r = await this.prisma?.toolCall?.aggregate?.({
        _sum: { credits: true },
        where: { createdAt: { gte: midnight }, credits: { not: null }, service: { in: platformSlugs } },
      });
      const n = Number(r?._sum?.credits);
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }

  /** The daily ceiling in force (BEA-1358): the Setting, else the default. Null = no limit (the owner set 0). */
  async ceiling(): Promise<number | null> {
    try {
      const row = await this.prisma?.setting?.findUnique?.({ where: { key: CEILING_KEY } });
      const raw = row?.value;
      if (raw === undefined || raw === null || String(raw).trim() === '') return CEILING_DEFAULT;
      const n = Number(raw);
      if (!Number.isFinite(n)) return CEILING_DEFAULT;
      return n <= 0 ? null : Math.floor(n);
    } catch {
      return CEILING_DEFAULT;
    }
  }

  /**
   * The form's values, typed the way the schema says and with blanks dropped: a number field
   * arrives as text from an input, a boolean as "true", and an empty optional field is nothing.
   * Anything the schema does not know is not sent on.
   */
  private cleanArgs(args: Record<string, any>, action: ServiceAction | null): Record<string, any> {
    const props: Record<string, any> = action?.schema?.properties || {};
    const names = Object.keys(props);
    const out: Record<string, any> = {};
    for (const [k, raw] of Object.entries(args || {})) {
      if (names.length && !names.includes(k)) continue;
      if (raw === undefined || raw === null || raw === '') continue;
      const type = String(props[k]?.type || '');
      if (type === 'integer' || type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        out[k] = type === 'integer' ? Math.trunc(n) : n;
      } else if (type === 'boolean') {
        out[k] = raw === true || String(raw).toLowerCase() === 'true' || String(raw) === '1';
      } else if ((type === 'array' || type === 'object') && typeof raw === 'string' && /^[[{]/.test(raw.trim())) {
        // A structured field typed as JSON (WhatsApp's list rows, a PDF's item table) — parsed,
        // and said plainly when it does not parse rather than sent on as one long string.
        try { out[k] = JSON.parse(raw); } catch { out[k] = raw; }
      } else if (type === 'array' && typeof raw === 'string') {
        out[k] = raw.split(',').map((x) => x.trim()).filter(Boolean);
      } else {
        out[k] = raw;
      }
    }
    return out;
  }

  private missingRequired(args: Record<string, any>, action: ServiceAction | null): string[] {
    const required: string[] = Array.isArray(action?.schema?.required) ? action!.schema.required : [];
    return required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
  }
}
