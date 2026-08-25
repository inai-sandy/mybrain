import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ToolCatalogService } from './tool-catalog.service';
import { ToolLookupService } from './tool-lookup.service';
import { ComposioProvider } from './composio.provider';
import { DocAction, docHash, toolDocText, toolIndexText } from './tool-doc';

/** How often every tool's document is rebuilt from the catalog, when nothing else has changed. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How often we check whether the owner has connected or disconnected something (BEA-1468).
 *
 * He asked the obvious question — *"when I link a new tool will it create a new document
 * immediately?"* — and the honest answer was no: it would have waited up to a day. Watching the
 * catalog's own generation counter catches EVERY road a connection can change by, including a
 * one-click sign-in that finishes minutes after the button was pressed, which no route handler could
 * hook on its own.
 */
const WATCH_MS = 20_000;

/**
 * ONE DOCUMENT PER TOOL, kept up to date, read by Codex (BEA-1468).
 *
 * His instruction: *"Each tool should have a document… Codex should have full access to all the
 * tools and actions… If the context is not proper, it cannot create the right agent."*
 *
 * Three rules this keeps:
 *
 *  - **every action, never a selection.** The catalog is walked whole. A shortlist is what left his
 *    first build unable to find Gmail, and choosing for Codex is the habit being removed;
 *  - **durable.** These are rows, not something assembled for one prompt and lost. Tomorrow's agent
 *    reads the same documents, which is what he asked for;
 *  - **honest about being stale.** A document says when it was built. A tool that has since gained
 *    actions is a document that is wrong, and the daily rebuild is what stops that mattering.
 */
@Injectable()
export class ToolDocsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ToolDocs');
  private building = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watch: ReturnType<typeof setInterval> | null = null;
  /** The connection generation the documents were last built for. */
  private builtGen = -1;

  constructor(
    private readonly prisma: PrismaService,
    // Optional + LAST — spec harnesses build services positionally with fewer arguments.
    private readonly catalog?: ToolCatalogService,
    private readonly lookup?: ToolLookupService,
    private readonly services?: ComposioProvider, // its generation moves whenever a connection changes
  ) {}

  onModuleInit() {
    // Behind the boot, never blocking it: a first build walks every connected service's whole action
    // list, which is thousands of rows and several vendor calls.
    setTimeout(() => void this.rebuild().catch((e) => this.log.warn(`first build failed: ${e?.message || e}`)), 30_000);
    // …and once a day after that. A vendor adding an action must not need anybody to notice.
    // A plain interval, like every other recurring job here — this project has no cron module.
    this.timer = setInterval(() => void this.rebuild().catch((e) => this.log.warn(`daily rebuild failed: ${e?.message || e}`)), DAY_MS);
    // …and the moment he connects or disconnects anything. A new tool with no document is a tool
    // Codex cannot find, which is exactly how his first real build failed.
    this.watch = setInterval(() => void this.ifConnectionsChanged(), WATCH_MS);
  }

  /**
   * Rebuild when the owner's connections have moved, and only then.
   *
   * Cheap: one integer compare per tick. The generation is the provider's own counter, so this sees
   * a connect, a disconnect, an added second account and a sign-in that completed asynchronously —
   * all the roads a route handler would have to be told about one at a time.
   */
  private async ifConnectionsChanged(): Promise<void> {
    const gen = this.services?.generation?.() ?? 0;
    if (gen === this.builtGen) return;
    this.builtGen = gen;
    const out = await this.rebuild().catch((e) => { this.log.warn(`rebuild after a connection change failed: ${e?.message || e}`); return null; });
    if (out?.changed) this.log.log(`connections changed — ${out.changed} tool document${out.changed === 1 ? '' : 's'} rewritten`);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    if (this.watch) clearInterval(this.watch);
    this.timer = null;
    this.watch = null;
  }

  /** What exists, for the "what tools do I have?" question. */
  async list(): Promise<{ service: string; name: string; actions: number; builtAt: string }[]> {
    const rows = await this.prisma?.toolDoc?.findMany?.({ orderBy: { service: 'asc' } }).catch(() => []);
    return (rows || []).map((r: any) => ({ service: r.service, name: r.name, actions: r.actions, builtAt: new Date(r.builtAt).toISOString() }));
  }

  /** The same list as one readable page — what the MCP hands back. */
  async indexText(): Promise<string> {
    const rows = await this.prisma?.toolDoc?.findMany?.({ orderBy: { service: 'asc' } }).catch(() => []);
    return toolIndexText((rows || []).map((r: any) => ({ service: r.service, name: r.name, actions: r.actions })));
  }

  /** One tool's document. Null when there is no such tool — never an invented one. */
  async get(service: string): Promise<{ service: string; name: string; actions: number; text: string; builtAt: string } | null> {
    const row = await this.prisma?.toolDoc?.findUnique?.({ where: { service: String(service || '').toLowerCase().trim() } }).catch(() => null);
    if (!row) return null;
    return { service: row.service, name: row.name, actions: row.actions, text: row.text, builtAt: new Date(row.builtAt).toISOString() };
  }

  /**
   * The detail of ONE action — the second level (`tool-doc.ts` explains why there are two).
   *
   * This is the existing fact card: the vendor's own parameters, the fields real answers have
   * carried, what it has cost, whether it is failing right now, and any trap written down about it.
   * Built live rather than stored, because the health half of it is only true for a few hours.
   */
  async action(actionId: string): Promise<{ actionId: string; text: string } | null> {
    const id = String(actionId || '').trim();
    if (!id.startsWith('svc:')) return null;
    // Through the LOOKUP service, which already renders a card as text. `cardText` itself lives with
    // the builder's prompt-writing, and importing that here would drag the agent module into the
    // catalog — the cycle `tool-lookup.service.ts` was written to avoid.
    const got = await this.lookup?.getAction?.(id).catch(() => null);
    if (!got) return null;
    return { actionId: id, text: String(got.text || '') };
  }

  /**
   * Rebuild every tool's document from the catalog.
   *
   * A document whose text has not changed is left alone entirely — its `builtAt` does not move — so
   * "when was this last actually different" stays a real answer rather than "when did the cron last run".
   */
  async rebuild(): Promise<{ tools: number; changed: number }> {
    if (this.building) return { tools: 0, changed: 0 };
    this.building = true;
    try {
      const cat: any = await this.catalog?.catalog?.().catch(() => null);
      const tools: any[] = Array.isArray(cat?.tools) ? cat.tools : [];
      const byService = new Map<string, { name: string; connected: boolean; actions: DocAction[] }>();

      for (const t of tools) {
        const id = String(t?.id || '');
        if (!id.startsWith('svc:')) continue;
        const service = String(t.service || '').toLowerCase();
        if (!service) continue;
        const seen = byService.get(service) || { name: pretty(service), connected: !!t.connected, actions: [] };
        seen.connected = seen.connected || !!t.connected;
        seen.actions.push({
          id,
          name: String(t.name || id),
          description: t.description ? String(t.description) : null,
          risky: !!t.risky,
          retired: !!t.retired,
          method: t.method ? String(t.method) : null,
        });
        byService.set(service, seen);
      }

      let changed = 0;
      for (const [service, v] of byService) {
        const text = toolDocText({ service, name: v.name, connected: v.connected, actions: v.actions });
        const hash = docHash(text);
        const now = await this.prisma?.toolDoc?.findUnique?.({ where: { service } }).catch(() => null);
        if (now?.hash === hash) continue; // nothing about this tool moved
        await this.prisma?.toolDoc?.upsert?.({
          where: { service },
          create: { service, name: v.name, actions: v.actions.length, text, hash },
          update: { name: v.name, actions: v.actions.length, text, hash, builtAt: new Date() },
        }).catch((e: any) => this.log.warn(`could not write the ${service} document: ${e?.message || e}`));
        changed++;
      }
      this.builtGen = this.services?.generation?.() ?? 0;
      if (changed) this.log.log(`tool documents: ${byService.size} tools, ${changed} changed`);
      return { tools: byService.size, changed };
    } finally {
      this.building = false;
    }
  }
}

/** `googlesheets` → `Googlesheets`. A label only — nothing is ever decided from it. */
function pretty(slug: string): string {
  const s = String(slug || '').replace(/[-_]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : slug;
}
