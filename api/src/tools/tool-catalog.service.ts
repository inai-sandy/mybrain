import { Injectable, Logger } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { SkillsService } from '../skills/skills.service';
import { GoogleService } from '../google/google.service';

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

export type ToolGroup = 'Brain' | 'Web' | 'Google' | 'Messaging' | 'Output' | 'AI' | 'Skills' | 'MCP servers' | 'Advanced';

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
};

/** The order groups are shown in — most reached-for first. */
export const GROUP_ORDER: ToolGroup[] = ['Brain', 'Web', 'Google', 'Messaging', 'Output', 'AI', 'Skills', 'MCP servers', 'Advanced'];

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
  { id: 'cli', name: 'Run a command', group: 'Advanced', kind: 'tool', connected: true, description: 'Run a command line tool on the engine host' },
];

@Injectable()
export class ToolCatalogService {
  private readonly log = new Logger('ToolCatalog');

  constructor(
    private readonly connectors: ConnectorService,
    private readonly skills: SkillsService,
    private readonly google?: GoogleService, // optional + LAST — spec files construct positionally
  ) {}

  /** The whole catalog, grouped, with a truthful connected flag on every entry. */
  async catalog(): Promise<{ groups: { group: ToolGroup; tools: CatalogTool[] }[]; tools: CatalogTool[] }> {
    const [connectors, skills, googleOn, engineOn] = await Promise.all([
      this.connectors.listStatus().catch(() => [] as { name: string; configured: boolean }[]),
      this.skills.list().catch(() => [] as any[]),
      this.googleConnected(),
      this.engineReachable(),
    ]);
    const has = (n: string) => connectors.some((c) => c.name === n && c.configured);

    const tools: CatalogTool[] = [
      ...BUILT_IN,
      ...this.webTools(has('tavily')),
      ...this.googleTools(googleOn),
      ...this.messagingTools(has('telegram')),
      ...this.skillTools(skills),
      ...this.mcpTools(engineOn),
    ];

    const groups = GROUP_ORDER.map((group) => ({ group, tools: tools.filter((t) => t.group === group) })).filter((g) => g.tools.length > 0);
    return { groups, tools };
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

  private webTools(tavily: boolean): CatalogTool[] {
    const hint = tavily ? undefined : 'Add your Tavily key in Settings → Connections';
    const path = tavily ? undefined : '/settings#connections';
    return [
      { id: 'web_search', name: 'Web search', group: 'Web', kind: 'tool', connected: tavily, description: 'Search the live web', connectHint: hint, connectPath: path },
      { id: 'web_read', name: 'Read a page', group: 'Web', kind: 'tool', connected: tavily, description: 'Open a link and read what it says', connectHint: hint, connectPath: path },
    ];
  }

  /** Every Workspace service we support. Keep is deliberately absent — Google gives no API for it. */
  private googleTools(on: boolean): CatalogTool[] {
    const svc: [string, string, string][] = [
      ['gmail', 'Gmail', 'Read and search your email'],
      ['calendar', 'Calendar', 'Look at what is in your diary'],
      ['drive', 'Drive', 'Find and read your files'],
      ['docs', 'Docs', 'Read a Google Doc'],
      ['sheets', 'Sheets', 'Read a spreadsheet'],
      ['slides', 'Slides', 'Read a slide deck'],
      ['tasks', 'Google Tasks', 'Read your Google task lists'],
      ['forms', 'Forms', 'Read a form and its answers'],
      ['meet', 'Meet', 'Look up meetings'],
      ['chat', 'Google Chat', 'Read your Chat messages'],
      ['contacts', 'Google Contacts', 'Look someone up in your contacts'],
    ];
    return svc.map(([id, name, description]) => ({
      id, name, description, group: 'Google' as const, kind: 'tool' as const, connected: on,
      connectHint: on ? undefined : 'Connect your Google account first',
      connectPath: on ? undefined : '/google',
    }));
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
  private skillTools(skills: any[]): CatalogTool[] {
    return (skills || []).slice(0, 200).map((s: any) => {
      const on = Array.isArray(s.installedOn) && s.installedOn.length > 0;
      return {
        id: s.id,
        name: s.title || 'Untitled skill',
        group: 'Skills' as const,
        kind: 'skill' as const,
        connected: on,
        description: (s.description || '').slice(0, 140) || 'One of your saved skills',
        connectHint: on ? undefined : 'Install this skill on the engine before using it',
        connectPath: on ? undefined : '/skills',
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

  private async googleConnected(): Promise<boolean> {
    if (!this.google) return false;
    try { return !!(await this.google.status()).connected; } catch { return false; }
  }

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
