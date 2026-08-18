import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { SkillsService } from '../skills/skills.service';
import { LlmService } from '../llm/llm.service';
import { ComposioProvider } from './composio.provider';
import { ScrapeCreatorsProvider } from './scrapecreators.provider';
import { isBlockedService, isServiceToolId, ServiceAction, ServiceInfo } from './service-provider';

/**
 * The ONE tool catalog (BEA-1167).
 *
 * Before this, "a tool" meant two unrelated things: the Flows canvas had a real grouped palette,
 * while an agent's Tools box was a free-text label you typed. Everything we build on top — the chat
 * proposing a tool set, EMO picking one automatically — needs a single list both sides read.
 *
 * Ids are STABLE and must stay that way: the flow executor dispatches on them
 * (`flows-runner.service.ts` → AGENT_TOOLS / toolPrompt). Adding ids is safe (an unknown id
 * degrades to a plain reasoning step); renaming one silently breaks saved flows.
 */

export type ToolGroup = 'Brain' | 'Web' | 'Services' | 'Social' | 'Messaging' | 'Output' | 'AI' | 'News' | 'Skills' | 'MCP servers' | 'Advanced';

export type CatalogTool = {
  id: string;
  name: string;
  group: ToolGroup;
  description: string;
  kind: 'tool' | 'skill' | 'mcp';
  connected: boolean;
  /** Plain English: what is missing, when it isn't connected. */
  connectHint?: string;
  /** Where the user goes to fix it. */
  connectPath?: string;
  /** Set on Services entries only — which outside service this action belongs to (BEA-1345). */
  service?: string;
  /** Set on Services entries only — true when the action cannot be undone (the gate reads this). */
  risky?: boolean;
  /**
   * Set on Services entries only, and only when true — the vendor's own "most used" mark (BEA-1354).
   * A hint for prompts and pickers; the catalog itself holds every action regardless.
   */
  important?: boolean;
  /**
   * Set on Services / Social entries only, and only when true — the vendor has retired the action
   * (BEA-1365). It stays in the catalog (nothing skipped); pickers tag it and list it after the live
   * ones, prompt shortlists rank it last.
   */
  retired?: boolean;
};

/** Live actions first, retired after — a stable partition, so nothing else about the order moves. */
export function liveFirst<T extends { retired?: boolean }>(actions: T[]): T[] {
  return [...actions.filter((a) => !a.retired), ...actions.filter((a) => a.retired)];
}

/** Shorten to a whole word — a description cut mid-word ("deployed so t") reads like a bug. */
export function clip(s: string | null | undefined, max: number): string {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

/** The order groups are shown in — most reached-for first. */
export const GROUP_ORDER: ToolGroup[] = ['Brain', 'Web', 'News', 'Services', 'Social', 'Messaging', 'Output', 'AI', 'Skills', 'MCP servers', 'Advanced'];

/*
 * EVERY action of a connected service goes into the catalog (BEA-1354). Until then it took the
 * provider's own shortlist and stopped at 60 — GitHub showed 36 of 871 — which hid ~95% of what a
 * service can do and contradicted the owner's standing instruction: "do not skip any action from
 * providers." The picker searches within a service and pages; a prompt is shown a keyword-ranked
 * slice (`tool-shortlist.ts`); nothing here cuts the list.
 */

/** How long the catalog will wait on outside services before answering with what it already had. */
const SERVICE_LOOKUP_BUDGET_MS = 8000;
/**
 * How long a service list is served as-is before it is re-read — the same five minutes the provider
 * keeps its own reads for. Past it the catalog still answers at once with what it has and re-reads
 * BEHIND the answer, so a full walk of every action (~1.5–3s cold) is paid by nobody but the very
 * first request after boot — and boot warms it too.
 */
const SERVICE_FRESH_MS = 5 * 60 * 1000;

/** Tools that are simply part of the app — nothing to connect. */
const BUILT_IN: CatalogTool[] = [
  { id: 'search_brain', name: 'Search my brain', group: 'Brain', kind: 'tool', connected: true, description: 'Everything you have saved — notes, documents and memories, searched by meaning' },
  { id: 'search_rag', name: 'Search raw notes', group: 'Brain', kind: 'tool', connected: true, description: 'Your note store only, without the memory layer on top' },
  { id: 'fetch_document', name: 'Open a document', group: 'Brain', kind: 'tool', connected: true, description: 'Read one of your documents in full' },
  { id: 'remember', name: 'Remember this', group: 'Brain', kind: 'tool', connected: true, description: 'Save a lasting fact into your long-term memory' },
  { id: 'ask_ai', name: 'Ask AI', group: 'AI', kind: 'tool', connected: true, description: 'A plain thinking step — no outside lookup' },
  { id: 'save_document', name: 'Save to Documents', group: 'Output', kind: 'tool', connected: true, description: 'Write the result into your document library' },
  { id: 'save_capture', name: 'Save a capture', group: 'Output', kind: 'tool', connected: true, description: 'File a note into your capture inbox' },
  { id: 'create_task', name: 'Create a task', group: 'Output', kind: 'tool', connected: true, description: 'Add a to-do to your task list' },
  { id: 'http', name: 'HTTP request', group: 'Advanced', kind: 'tool', connected: true, description: 'Call any external API directly' },
  // AI News Daily (BEA-1259). Three real steps so the canvas can SHOW the pipeline, while the work
  // itself stays in our code — an engine turn averages 118,000 tokens, and the engine must never be
  // the thing deciding whether a story was kept.
  { id: 'news_collect', name: 'Collect the AI news', group: 'News', kind: 'tool', connected: true, description: 'Pull the feed, split every story out and file each one into a category' },
  { id: 'news_write', name: 'Write the edition', group: 'News', kind: 'tool', connected: true, description: 'Turn the categorised stories into the day\'s edition — headline, 60-second read, a section per category' },
  { id: 'news_flag', name: 'Pick what needs research', group: 'News', kind: 'tool', connected: true, description: 'Shortlist the few stories worth a proper dig, for the end of the edition' },
  { id: 'cli', name: 'Run a command', group: 'Advanced', kind: 'tool', connected: true, description: 'Run a command line tool on the engine host' },
];

@Injectable()
export class ToolCatalogService implements OnModuleInit {
  private readonly log = new Logger('ToolCatalog');
  /** How long outside services may hold the catalog up. A field so a test can shrink it. */
  serviceBudgetMs = SERVICE_LOOKUP_BUDGET_MS;

  constructor(
    private readonly connectors: ConnectorService,
    private readonly skills: SkillsService,
    // Optional + LAST — spec files construct positionally with fewer args.
    private readonly llm?: LlmService, // to know which engine is chosen (BEA-1224)
    private readonly services?: ComposioProvider, // outside services, behind the seam (BEA-1345)
    private readonly social?: ScrapeCreatorsProvider, // social platforms, behind the same seam (BEA-1355)
  ) {}

  /**
   * The last service list that came back cleanly — what is served while a re-read runs behind, and
   * what we fall back to when the provider is slow. `at` is when it was read; `gen` is the
   * provider's generation at the time, so a connect/disconnect makes it stale at once.
   */
  private lastServices: { tools: CatalogTool[]; available: boolean; at: number; gen: number } | null = null;
  /**
   * The one re-read in flight, so a burst of stale requests starts one walk, not ten. Keyed by the
   * provider generation it was started for: a connect/disconnect DURING a walk starts a fresh one
   * rather than handing the newcomer a list read before the change.
   */
  private servicesRefresh: { gen: number; promise: Promise<{ tools: CatalogTool[]; available: boolean }> } | null = null;
  /** The same, for the Social group. */
  private lastSocial: { tools: CatalogTool[]; available: boolean } | null = null;

  /** Warm the service list at boot, so the first picker of the day is not the one paying for it. */
  onModuleInit() {
    if (!this.services) return;
    setTimeout(() => { this.serviceTools().catch(() => undefined); }, 2000).unref?.();
  }

  /** The whole catalog, grouped, with a truthful connected flag on every entry. */
  async catalog(): Promise<{ groups: { group: ToolGroup; tools: CatalogTool[] }[]; tools: CatalogTool[] }> {
    const [connectors, skills, engineOn, engine, services, social] = await Promise.all([
      this.connectors.listStatus().catch(() => [] as { name: string; configured: boolean }[]),
      this.skills.list().catch(() => [] as any[]),
      this.engineReachable(),
      this.llm?.engineChoice?.().then((c: any) => c?.provider || 'codex').catch(() => 'codex') ?? Promise.resolve('codex'),
      this.serviceTools(),
      this.socialTools(),
    ]);
    const has = (n: string) => connectors.some((c) => c.name === n && c.configured);

    const tools: CatalogTool[] = [
      ...BUILT_IN,
      ...this.webTools(has('tavily'), has('exa'), has('brave')),
      // Google (Gmail, Calendar, Drive…) is NOT a group of its own any more (BEA-1351): it comes
      // through the seam below like every other outside service, so it appears exactly once.
      ...services.tools,
      // Social platforms (BEA-1355) — the second provider on the same seam, one line beside the first.
      ...social.tools,
      ...this.messagingTools(has('telegram')),
      ...this.skillTools(skills, engine),
      ...this.mcpTools(engineOn),
    ];

    const groups = GROUP_ORDER.map((group) => ({ group, tools: tools.filter((t) => t.group === group) }))
      // Services is the one group allowed to be empty: when a working key is set but nothing is
      // connected yet, its presence is what tells the UI to offer connecting something.
      .filter((g) => g.tools.length > 0 || (g.group === 'Services' && services.available));
    return { groups, tools };
  }

  /**
   * Just the outside-service entries, live ones only (BEA-1349).
   *
   * The SAME builder the whole catalog uses — not a second list — because Chat has to answer "is
   * anything connected?" on every single message, and paying for skills, Google and an engine ping
   * to find that out would slow down the one screen the owner is on all day. When nothing is
   * connected this is an empty array, and Chat must then behave exactly as it did before.
   */
  async connectedServiceTools(): Promise<CatalogTool[]> {
    const [services, social] = await Promise.all([this.serviceTools(), this.socialTools()]);
    return [...services.tools, ...social.tools].filter((t) => t.connected);
  }

  /** One tool by id — used when a picked set is validated before a run. */
  async byId(id: string): Promise<CatalogTool | null> {
    const { tools } = await this.catalog();
    return tools.find((t) => t.id === id) || null;
  }

  /** Split a picked list into the ones that really exist and the ones that don't. */
  async validate(ids: string[]): Promise<{ ok: CatalogTool[]; unknown: string[]; notConnected: CatalogTool[] }> {
    const { tools } = await this.catalog();
    const byId = new Map(tools.map((t) => [t.id, t]));
    const ok: CatalogTool[] = [];
    const unknown: string[] = [];
    const notConnected: CatalogTool[] = [];
    for (const id of ids || []) {
      const t = byId.get(id);
      if (!t) { unknown.push(id); continue; }
      ok.push(t);
      if (!t.connected) notConnected.push(t);
    }
    return { ok, unknown, notConnected };
  }

  // ---- groups that depend on something being connected ----------------------------------------

  private webTools(tavily: boolean, exa: boolean, brave = false): CatalogTool[] {
    const tHint = tavily ? undefined : 'Add your Tavily key in Settings → Connections';
    const eHint = exa ? undefined : 'Add your Exa key in Settings → Connections';
    const path = '/settings#connections';
    return [
      { id: 'web_search', name: 'Web search', group: 'Web', kind: 'tool', connected: tavily, description: 'Search the live web by keyword, with sources (Tavily)', connectHint: tHint, connectPath: tavily ? undefined : path },
      { id: 'web_read', name: 'Read a page', group: 'Web', kind: 'tool', connected: tavily, description: 'Open a link and read what it says (Tavily)', connectHint: tHint, connectPath: tavily ? undefined : path },
      // Semantic search (BEA-1194) — for the questions where you don't know the right keywords.
      { id: 'web_search_meaning', name: 'Search by meaning', group: 'Web', kind: 'tool', connected: exa, description: 'Finds pages about an idea, even when you do not know the right words (Exa)', connectHint: eHint, connectPath: exa ? undefined : path },
      // Our own research loop (BEA-1196) — many searches, then the report, on the flat-rate engine.
      // Either search back-end is enough to run it.
      {
        id: 'deep_research', name: 'Deep research', group: 'Web', kind: 'tool', connected: tavily || exa || brave,
        description: 'Breaks your question up, searches many sources, reads the best pages and writes a report with citations',
        connectHint: tavily || exa || brave ? undefined : 'Add a Brave, Tavily or Exa key in Settings → Connections',
        connectPath: tavily || exa || brave ? undefined : path,
      },
    ];
  }

  /**
   * The outside services the owner has connected, as catalog entries (BEA-1345).
   *
   * Everything here comes through the `ServiceProvider` seam, so the catalog never learns which
   * vendor supplies them — every id is `svc:<service>.<action>` and nothing else. Blocked services
   * (`exa · firecrawl · tavily · perplexity · telegram · whatsapp`) are dropped inside the provider,
   * because we already do those better or they are ours.
   *
   * `available` is separate from the entries on purpose: a working key with nothing connected yet
   * must still show a Services group, or the UI has nowhere to put "connect something".
   */
  private async serviceTools(): Promise<{ tools: CatalogTool[]; available: boolean }> {
    if (!this.services) return { tools: [], available: false };
    const gen = this.services.generation?.() ?? 0;
    const last = this.lastServices;
    // Still good: same connections, read less than five minutes ago.
    if (last && last.gen === gen && Date.now() - last.at < SERVICE_FRESH_MS) return last;
    // Merely old: answer with it NOW and re-read behind the answer (one walk at a time).
    if (last && last.gen === gen) {
      this.refreshServices(gen);
      return last;
    }
    // Nothing yet, or the connections changed: this request waits — but never past the budget.
    // The catalog is read on nearly every page. An outside service is allowed to be slow, but it is
    // never allowed to hold the catalog up — past the budget we answer with the last good list.
    const budget = new Promise<{ tools: CatalogTool[]; available: boolean } | null>((r) => setTimeout(() => r(null), this.serviceBudgetMs).unref?.());
    const fresh = await Promise.race([this.refreshServices(gen), budget]);
    if (fresh) return fresh;
    return this.lastServices || { tools: [], available: false };
  }

  /**
   * One re-read at a time per generation; a clean answer becomes the new last-good list, a failed
   * one changes nothing, and an older walk can never overwrite a newer generation's list.
   */
  private refreshServices(gen: number): Promise<{ tools: CatalogTool[]; available: boolean }> {
    if (!this.servicesRefresh || this.servicesRefresh.gen !== gen) {
      const promise = this.loadServiceTools()
        .then((fresh) => {
          if (fresh.available && gen >= (this.lastServices?.gen ?? -1)) this.lastServices = { ...fresh, at: Date.now(), gen };
          return fresh;
        })
        .finally(() => { if (this.servicesRefresh?.promise === promise) this.servicesRefresh = null; });
      this.servicesRefresh = { gen, promise };
    }
    return this.servicesRefresh.promise;
  }

  private async loadServiceTools(): Promise<{ tools: CatalogTool[]; available: boolean }> {
    try {
      const status = await this.services!.status();
      if (!status.configured || !status.reachable) return { tools: [], available: false };

      // Belt and braces: the provider already drops blocked services, but the promise "these never
      // appear in the catalog" is made HERE, so it is kept here too.
      const services: ServiceInfo[] = (await this.services!.listServices({ connectedOnly: true })).filter((s) => !isBlockedService(s.slug));
      // EVERY action, no shortlist, no cap (BEA-1354). The provider walks the whole paged list and
      // caches it, and this whole build is served from memory for five minutes and re-read behind
      // the answer after that — so "all of them" costs the catalog nothing per request.
      const perService = await Promise.all(
        services.map(async (s) => ({
          service: s,
          actions: await this.services!.listActions(s.slug).catch(() => [] as ServiceAction[]),
        })),
      );

      const tools: CatalogTool[] = [];
      for (const { service, actions } of perService) {
        const live = service.accounts.some((a) => a.status === 'ACTIVE');
        // Retired actions stay in (BEA-1365) — tagged, and after the live ones.
        for (const a of liveFirst(actions)) {
          // The catalog's promise is that every service id has exactly one shape. Anything else a
          // provider hands back is dropped rather than let loose among the load-bearing ids.
          if (!isServiceToolId(a.id)) continue;
          tools.push({
            id: a.id,
            name: `${service.name}: ${a.name}`,
            group: 'Services',
            kind: 'tool',
            connected: live,
            description: clip(a.description, 160) || `${a.name} on ${service.name}`,
            service: service.slug,
            risky: a.risky,
            ...(a.important ? { important: true } : {}),
            ...(a.retired ? { retired: true } : {}),
            connectHint: live ? undefined : `Your ${service.name} login needs finishing`,
            connectPath: live ? undefined : '/tools',
          });
        }
      }
      return { tools, available: true };
    } catch {
      // A wrong key, a slow network or an outage must never cost us the built-in tools.
      return { tools: [], available: false };
    }
  }

  /**
   * The Social group (BEA-1355): every platform's every endpoint, generated from the provider's
   * spec — the whole list, no cap, because a test asserts action count == the spec's op count.
   *
   * Present ONLY when the key is set: without one the catalog is exactly what it was before. The
   * provider itself never blocks (it answers from its last good list when the spec host is down),
   * and the same budget as Services applies on top, so the catalog's answer time does not move.
   */
  private async socialTools(): Promise<{ tools: CatalogTool[]; available: boolean }> {
    if (!this.social) return { tools: [], available: false };
    const budget = new Promise<{ tools: CatalogTool[]; available: boolean } | null>((r) => setTimeout(() => r(null), SERVICE_LOOKUP_BUDGET_MS).unref?.());
    const fresh = await Promise.race([this.loadSocialTools(), budget]);
    if (fresh) {
      if (fresh.available) this.lastSocial = fresh;
      return fresh;
    }
    return this.lastSocial || { tools: [], available: false };
  }

  private async loadSocialTools(): Promise<{ tools: CatalogTool[]; available: boolean }> {
    try {
      const status = await this.social!.status();
      // Configured is the whole test. Reachable is not: their API being down for a minute must not
      // empty the group, and the spec (last good copy) is what the list is built from anyway.
      if (!status.configured) return { tools: [], available: false };
      const services: ServiceInfo[] = await this.social!.listServices({ connectedOnly: true });
      const perService = await Promise.all(
        services.map(async (s) => ({ service: s, actions: await this.social!.listActions(s.slug).catch(() => [] as ServiceAction[]) })),
      );
      const tools: CatalogTool[] = [];
      for (const { service, actions } of perService) {
        for (const a of liveFirst(actions)) {
          if (!isServiceToolId(a.id)) continue;
          tools.push({
            id: a.id,
            name: `${service.name}: ${a.name}`,
            group: 'Social',
            kind: 'tool',
            connected: service.connected,
            description: clip(a.description, 160) || `${a.name} on ${service.name}`,
            service: service.slug,
            risky: false,
            ...(a.retired ? { retired: true } : {}),
          });
        }
      }
      return { tools, available: tools.length > 0 };
    } catch {
      return { tools: [], available: false };
    }
  }

  private messagingTools(telegram: boolean): CatalogTool[] {
    const whatsapp = !!process.env.POSTBOX_ADMIN_TOKEN;
    return [
      {
        id: 'telegram', name: 'Send to Telegram', group: 'Messaging', kind: 'tool', connected: telegram,
        description: 'Message you on Telegram when it is done',
        connectHint: telegram ? undefined : 'Add your Telegram bot token in Settings → Connections',
        connectPath: telegram ? undefined : '/settings#connections',
      },
      {
        id: 'whatsapp', name: 'Send on WhatsApp', group: 'Messaging', kind: 'tool', connected: whatsapp,
        description: 'Message you on WhatsApp when it is done',
        connectHint: whatsapp ? undefined : 'WhatsApp is not set up on this server yet',
        connectPath: whatsapp ? undefined : '/settings#connections',
      },
    ];
  }

  /** Your installed skills. "Connected" means the skill's folder really exists on a target. */
  /**
   * Your skills, and whether the engine you picked can actually run each one (BEA-1224).
   *
   * This used to call a skill available if it was installed on ANY target. But `beakn` is a separate
   * machine account that neither engine reads, so a skill sitting only there was offered on the
   * canvas and then failed at run time. Only the engine's own folder counts.
   */
  private skillTools(skills: any[], engine: string): CatalogTool[] {
    const engineRunsSkills = SkillsService.SKILL_ENGINES.includes(engine);
    return (skills || []).slice(0, 200).map((s: any) => {
      const onEngine = Array.isArray(s.installedOn) && s.installedOn.includes(SkillsService.ENGINE_TARGET);
      const on = engineRunsSkills && onEngine;
      const why = !engineRunsSkills
        ? `Your engine (${engine}) cannot run skills — switch to Codex or Claude in Settings → Models`
        : 'Install this skill so your engine can read it — Skills → Install';
      return {
        id: s.id,
        name: s.title || 'Untitled skill',
        group: 'Skills' as const,
        kind: 'skill' as const,
        connected: on,
        description: clip(s.description, 140) || 'One of your saved skills',
        connectHint: on ? undefined : why,
        connectPath: on ? undefined : engineRunsSkills ? '/skills' : '/settings#models',
      };
    });
  }

  /** MCP servers the engine can reach. Today that is our own; imported agents add more. */
  private mcpTools(engineOn: boolean): CatalogTool[] {
    return [{
      id: 'mcp:mybrain',
      name: 'My Brain MCP',
      group: 'MCP servers',
      kind: 'mcp',
      connected: engineOn,
      description: 'The server that lets the agent read your brain and save documents',
      connectHint: engineOn ? undefined : 'The engine host is not answering right now',
      connectPath: engineOn ? undefined : '/settings#engine',
    }];
  }

  // ---- probes ---------------------------------------------------------------------------------

  private async engineReachable(): Promise<boolean> {
    const runner = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';
    try {
      const r = await fetch(`${runner}/status`, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) return false;
      const s: any = await r.json();
      return !!s.ready;
    } catch { return false; }
  }
}
