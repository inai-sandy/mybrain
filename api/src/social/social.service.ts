import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey, TZ_OFFSET_MIN } from '../common/localday';
import { ScrapeCreatorsProvider } from '../tools/scrapecreators.provider';
import { ServiceActionsService, ServiceRunResult } from '../tools/service-actions.service';
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
 * social platforms only. The daily ceiling (`social.dailyCreditCeiling`) is READ here and shown;
 * it is set and enforced in BEA-1358 — until then the page says "no limit set".
 */

/** The Setting key the ceiling will live under (BEA-1358). Read-only here. */
export const CEILING_KEY = 'social.dailyCreditCeiling';

/** Where to top up. Shown when the provider answers 402 — never a raw error. */
export const TOP_UP_URL = 'https://scrapecreators.com';

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
};

export type SocialOverview = {
  status: { configured: boolean; reachable: boolean; message?: string };
  balance: number | null;
  spentToday: number;
  ceiling: number | null;
  platforms: SocialPlatform[];
  spec: { source: string; generatedAt?: string; opCount: number; platformCount: number; lastError?: string };
  topUpUrl: string;
};

/** What the run route answers. `data` is the provider's whole envelope. */
export type SocialRunResult = ServiceRunResult & { topUpUrl?: string };

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
  ) {}

  /** The grid page in one answer: key state, balance, today's spend, the ceiling, every platform. */
  async overview(refresh = false): Promise<SocialOverview> {
    // Waited for (bounded): "check again" must answer with the list AFTER the re-read, not before.
    if (refresh) await this.social.reload?.().catch(() => undefined);
    const [status, services] = await Promise.all([
      this.social.status().catch((e: any) => ({ configured: false, reachable: false, message: String(e?.message || e) })),
      this.social.listServices().catch(() => [] as ServiceInfo[]),
    ]);
    const platforms = await Promise.all(services.map((s) => this.platformRow(s)));
    const [balance, spentToday, ceiling] = await Promise.all([
      status.configured && status.reachable ? this.social.creditBalance().catch(() => null) : Promise.resolve(null),
      this.spentToday(platforms.map((p) => p.slug)),
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
  async platform(slug: string): Promise<{ platform: SocialPlatform; actions: ServiceAction[] } | null> {
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
    if (!(await this.social.owns(id).catch(() => false))) {
      return { ok: false, error: 'That is not one of the social endpoints we know. Reload the page and pick it again.' };
    }
    const action = await this.social.getAction(id).catch(() => null);
    const clean = this.cleanArgs(args, action);
    const missing = this.missingRequired(clean, action);
    if (missing.length) {
      return { ok: false, error: `Fill in ${missing.join(', ')} first — ${action?.name || 'this endpoint'} needs ${missing.length === 1 ? 'it' : 'them'}.` };
    }
    const r = await this.actions.runDetailed(id, '', { runKind: 'social', args: clean, argsPinned: true, label: action?.name });
    // 402 = out of credits. The owner gets a sentence and a place to top up, never the raw refusal.
    if (!r.ok && r.outOfCredits) {
      return { ...r, error: 'Your Scrape Creators credits are out. Top up, then run it again.', topUpUrl: TOP_UP_URL };
    }
    return r;
  }

  // ---- pieces ------------------------------------------------------------------------------

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

  /** The daily ceiling, when one is set (BEA-1358 sets it). Null = "no limit set". */
  private async ceiling(): Promise<number | null> {
    try {
      const row = await this.prisma?.setting?.findUnique?.({ where: { key: CEILING_KEY } });
      const n = Number(row?.value);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
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
