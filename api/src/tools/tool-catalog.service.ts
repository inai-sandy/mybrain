import { Injectable, Logger } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { SkillsService } from '../skills/skills.service';
import { LlmService } from '../llm/llm.service';
import { ComposioProvider } from './composio.provider';
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

export type ToolGroup = 'Brain' | 'Web' | 'Services' | 'Messaging' | 'Output' | 'AI' | 'News' | 'Skills' | 'MCP servers' | 'Advanced';

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
};

/** Shorten to a whole word — a description cut mid-word ("deployed so t") reads like a bug. */
export function clip(s: string | null | undefined, max: number): string {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

/** The order groups are shown in — most reached-for first. */
export const GROUP_ORDER: ToolGroup[] = ['Brain', 'Web', 'News', 'Services', 'Messaging', 'Output', 'AI', 'Skills', 'MCP servers', 'Advanced'];

/**
 * How many of a service's actions go into the catalog (BEA-1345).
 *
 * GitHub alone has 871. A picker cannot show that and a prompt must never carry it, so the catalog
 * takes the provider's own shortlist of important actions (GitHub 36, Gmail 13) and stops there.
 * The full set is always one `listActions()` call away for execution and search.
 */
const MAX_SERVICE_ACTIONS = 60;

/** How long the catalog will wait on outside services before answering with what it already had. */
const SERVICE_LOOKUP_BUDGET_MS = 8000;

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
export class ToolCatalogService {
  private readonly log = new Logger('ToolCatalog');

  constructor(
    private readonly connectors: ConnectorService,
    private readonly skills: SkillsService,
    // Optional + LAST — spec files construct positionally with fewer args.
    private readonly llm?: LlmService, // to know which engine is chosen (BEA-1224)
    private readonly services?: ComposioProvider, // outside services, behind the seam (BEA-1345)
  ) {}

  /** The last service list that came back cleanly — what we fall back to when Composio is slow. */
  private lastServices: { tools: CatalogTool[]; available: boolean } | null = null;

  /** The whole catalog, grouped, with a truthful connected flag on every entry. */
  async catalog(): Promise<{ groups: { group: ToolGroup; tools: CatalogTool[] }[]; tools: CatalogTool[] }> {
    const [connectors, skills, engineOn, engine, services] = await Promise.all([
      this.connectors.listStatus().catch(() => [] as { name: string; configured: boolean }[]),
      this.skills.list().catch(() => [] as any[]),
      this.engineReachable(),
      this.llm?.engineChoice?.().then((c: any) => c?.provider || 'codex').catch(() => 'codex') ?? Promise.resolve('codex'),
      this.serviceTools(),
    ]);
    const has = (n: string) => connectors.some((c) => c.name === n && c.configured);

    const tools: CatalogTool[] = [
      ...BUILT_IN,
      ...this.webTools(has('tavily'), has('exa'), has('brave')),
      // Google (Gmail, Calendar, Drive…) is NOT a group of its own any more (BEA-1351): it comes
      // through the seam below like every other outside service, so it appears exactly once.
      ...services.tools,
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
    const { tools } = await this.serviceTools();
    return tools.filter((t) => t.connected);
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
    // The catalog is read on nearly every page. An outside service is allowed to be slow, but it is
    // never allowed to hold the catalog up — past the budget we answer with the last good list.
    const budget = new Promise<{ tools: CatalogTool[]; available: boolean } | null>((r) => setTimeout(() => r(null), SERVICE_LOOKUP_BUDGET_MS).unref?.());
    const fresh = await Promise.race([this.loadServiceTools(), budget]);
    if (fresh) {
      if (fresh.available) this.lastServices = fresh;
      return fresh;
    }
    return this.lastServices || { tools: [], available: false };
  }

  private async loadServiceTools(): Promise<{ tools: CatalogTool[]; available: boolean }> {
    try {
      const status = await this.services!.status();
      if (!status.configured || !status.reachable) return { tools: [], available: false };

      // Belt and braces: the provider already drops blocked services, but the promise "these never
      // appear in the catalog" is made HERE, so it is kept here too.
      const services: ServiceInfo[] = (await this.services!.listServices({ connectedOnly: true })).filter((s) => !isBlockedService(s.slug));
      const perService = await Promise.all(
        services.map(async (s) => {
          const actions: ServiceAction[] = await this.services!
            .listActions(s.slug, { important: true, limit: MAX_SERVICE_ACTIONS })
            .catch(() => [] as ServiceAction[]);
          return { service: s, actions: actions.slice(0, MAX_SERVICE_ACTIONS) };
        }),
      );

      const tools: CatalogTool[] = [];
      for (const { service, actions } of perService) {
        const live = service.accounts.some((a) => a.status === 'ACTIVE');
        for (const a of actions) {
          if (a.deprecated) continue;
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
