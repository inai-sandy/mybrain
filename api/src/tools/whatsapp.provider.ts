import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  ConnectResult,
  ExecuteResult,
  isRiskyAction,
  isServiceToolId,
  parseServiceToolId,
  ProviderStatus,
  ServiceAccount,
  ServiceAction,
  ServiceInfo,
  ServiceProvider,
  serviceToolId,
} from './service-provider';

/**
 * WhatsApp, behind the ServiceProvider seam — the THIRD provider (BEA-1384).
 *
 * The service is our own WhatsApp gateway's general MCP server (streamable HTTP, stateless: one
 * POST per JSON-RPC call, the answer comes back as JSON or as a one-event SSE stream). The OWNER
 * sees one service, `whatsapp`, under Social; the ids are `svc:whatsapp.<tool>` and the gateway's
 * own name never appears in one — saved flows dispatch on these for ever (BEA-1345).
 *
 * **The tool list is the server's, never a hand list.** `tools/list` is read at boot, once a day
 * and on `refresh()`; the last good list is kept on disk under `DATA_DIR` so the gateway being
 * down for a minute does not empty the service. Name, description and argument schema all come
 * from the live answer, so a new tool on the gateway appears here without a deploy.
 *
 * **Gates (the map this issue exists for):** a sent WhatsApp message and a deleted template cannot
 * be taken back, so `send_template · send_text · send_list · send_rfq · delete_template` carry
 * `risky: true` and stop at the usual can't-undo gate (BEA-1348). Every read (`get_* · list_* ·
 * check_replies · broadcast_status`) and the two undoable writes (`create_template` — a pending
 * template can be deleted; `generate_pdf` — it only makes a file) run with no friction. The
 * hand-kept set is FIRST and `isRiskyAction()` runs on top, so a new `delete_*` tool on the
 * gateway is gated by the name rule even before this list learns it.
 *
 * **No metering.** The gateway does not charge credits, so `execute()` never returns `credits` and
 * the Social ceiling is untouched by these calls. Reads carry `method: 'GET'` so the builder's
 * sampler recognises them (`broadcast_status` and `get_stats` are reads whose first word is not a
 * read verb); everything else is `POST`.
 *
 * **The token is a server secret.** `WHATSAPP_MCP_TOKEN` (deploy.sh), never stored in code or in
 * the database, never echoed in an error. Without it the provider is honestly not configured:
 * `status()` says so, `listServices({connectedOnly})` answers nothing, and `execute()` refuses
 * with a sentence instead of pretending.
 */

const MCP_URL = () => process.env.WHATSAPP_MCP_URL || 'https://postbox.1site.ai/mcp';
const TOKEN = () => (process.env.WHATSAPP_MCP_TOKEN || '').trim();
/** Where the last good tool list is kept across restarts. */
const TOOLS_CACHE_FILE = () => process.env.WHATSAPP_MCP_TOOLS_CACHE || join(process.env.DATA_DIR || '/app/data', 'whatsapp-mcp-tools.json');

/** Once a day, plus on demand — the same rhythm as the other spec-generated provider. */
const LIST_REFRESH_MS = 24 * 60 * 60 * 1000;
const LIST_TIMEOUT_MS = 15_000;
/** A send with a PDF header can take a moment; the caller may pass its own. */
const CALL_TIMEOUT_MS = 60_000;
/** How long a status verdict is served before the gateway is asked again. */
const STATUS_CACHE_MS = 60_000;
/** How long a read waits for the first list before answering with what it has. */
const READY_WAIT_MS = 6000;

export const WHATSAPP_SERVICE = 'whatsapp';
const CATEGORY = { id: 'social', name: 'Social' };
/** The one "account": the server token. Its id is ours; the label is what the owner sees. */
const ACCOUNT: ServiceAccount = { id: 'default', label: 'WhatsApp (server token)', status: 'ACTIVE' };

/**
 * The can't-undo set, by tool name (BEA-1384). A sent message reaches a real phone and a deleted
 * template is gone at Meta — neither can be taken back. `send_rfq` broadcasts to every KIOT vendor
 * in a category, which is the most irreversible of the lot.
 */
export const GATED_TOOLS = new Set(['send_template', 'send_text', 'send_list', 'send_rfq', 'delete_template']);

/** The doc's own grouping, so the platform page reads like the owner's document. */
const TOOL_TAGS: Record<string, string> = {
  send_template: 'Sending', send_text: 'Sending', send_list: 'Sending', send_rfq: 'Sending',
  get_conversation: 'Reading', list_messages: 'Reading', check_replies: 'Reading', broadcast_status: 'Reading',
  get_stats: 'Status & info', list_numbers: 'Status & info', list_broadcasts: 'Status & info', list_categories: 'Status & info',
  list_templates: 'Templates & files', create_template: 'Templates & files', delete_template: 'Templates & files', generate_pdf: 'Templates & files',
};
const TAG_ORDER = ['Sending', 'Reading', 'Status & info', 'Templates & files', 'Other'];

// ---- generation (pure — exported for the tests) -------------------------------------------

/** One tool as `tools/list` answers it. */
export type McpTool = { name: string; description?: string; inputSchema?: any };

function titleCase(slug: string): string {
  return slug.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Is this tool a read? The hand-kept map first, then the verb — `broadcast_status` is a read. */
export function isWhatsAppRead(name: string): boolean {
  if (GATED_TOOLS.has(name)) return false;
  return /^(get|list|check|broadcast_status)/.test(name);
}

/**
 * One MCP tool → one ServiceAction. Risky = the hand-kept can't-undo set OR the name rule, so a
 * new `delete_*` tool on the gateway is gated even before `GATED_TOOLS` learns it.
 */
export function toWhatsAppAction(t: McpTool): ServiceAction {
  const name = String(t?.name || '').trim();
  const id = serviceToolId(WHATSAPP_SERVICE, name);
  const schema = t?.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object', properties: {} };
  delete schema.$schema;
  return {
    id,
    name: titleCase(name),
    description: String(t?.description || '').trim(),
    schema,
    risky: GATED_TOOLS.has(name) || isRiskyAction(id),
    service: WHATSAPP_SERVICE,
    method: isWhatsAppRead(name) ? 'GET' : 'POST',
    tags: [TOOL_TAGS[name] || 'Other'],
  };
}

/** The whole list, in the doc's group order, then the server's own order inside a group. */
export function generateWhatsAppActions(tools: McpTool[]): ServiceAction[] {
  const list = (Array.isArray(tools) ? tools : []).filter((t) => t && typeof t.name === 'string' && t.name.trim()).map(toWhatsAppAction);
  return list.sort((a, b) => TAG_ORDER.indexOf(a.tags![0]) - TAG_ORDER.indexOf(b.tags![0]));
}

// ---- the provider ------------------------------------------------------------------------

@Injectable()
export class WhatsAppProvider implements ServiceProvider, OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('WhatsApp');
  private actions: ServiceAction[] = [];
  private byId = new Map<string, ServiceAction>();
  /** Where the current list came from — for the status line and the tests. */
  private source: 'none' | 'disk' | 'live' | 'given' = 'none';
  private loading: Promise<any> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private gen = 0;
  private lastStatus: { at: number; value: ProviderStatus } | null = null;
  private rpcId = 0;

  // ---- lifecycle ---------------------------------------------------------------------------

  onModuleInit() {
    this.loadFromDisk();
    if (!TOKEN()) return; // not configured: nothing to read, and nothing must be pretended
    this.loading = this.loadTools().catch(() => undefined);
    this.timer = setInterval(() => { this.loadTools().catch(() => undefined); }, LIST_REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Read `tools/list` from the gateway and regenerate. On failure the last good list stays. */
  async loadTools(): Promise<{ ok: boolean; count: number; message?: string }> {
    try {
      const r = await this.rpc('tools/list', {}, LIST_TIMEOUT_MS);
      const tools: McpTool[] = Array.isArray(r?.tools) ? r.tools : [];
      if (!tools.length) throw new Error('the tool list came back empty');
      this.use(generateWhatsAppActions(tools), 'live');
      this.saveToDisk(tools);
      this.log.log(`tool list read: ${tools.length} WhatsApp actions`);
      return { ok: true, count: tools.length };
    } catch (e: any) {
      const why = String(e?.message || e).slice(0, 160);
      this.log.warn(`could not read the WhatsApp tool list (${why}) — serving the last good list (${this.actions.length}, ${this.source})`);
      return { ok: false, count: this.actions.length, message: why };
    }
  }

  /** Take a tool list directly — the tests' door. */
  useTools(tools: McpTool[]) {
    this.use(generateWhatsAppActions(tools), 'given');
  }

  private use(actions: ServiceAction[], source: 'disk' | 'live' | 'given') {
    this.actions = actions;
    this.byId = new Map(actions.map((a) => [a.id, a]));
    this.source = source;
    this.gen++;
  }

  private loadFromDisk() {
    try {
      const raw = JSON.parse(readFileSync(TOOLS_CACHE_FILE(), 'utf8'));
      const actions = generateWhatsAppActions(raw);
      if (actions.length) this.use(actions, 'disk');
    } catch {
      /* no copy yet — the live read is the answer */
    }
  }

  private saveToDisk(tools: McpTool[]) {
    try {
      const file = TOOLS_CACHE_FILE();
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(tools));
      renameSync(tmp, file);
    } catch (e: any) {
      this.log.warn(`could not keep a copy of the WhatsApp tool list on disk: ${e?.message || e}`);
    }
  }

  /** The list, waiting a bounded moment for the first read if it is still in flight. */
  private async ready(): Promise<ServiceAction[]> {
    if (this.actions.length || !this.loading) return this.actions;
    await Promise.race([this.loading, new Promise((r) => setTimeout(r, READY_WAIT_MS).unref?.())]);
    return this.actions;
  }

  // ---- the seam ----------------------------------------------------------------------------

  generation(): number {
    return this.gen;
  }

  async status(): Promise<ProviderStatus> {
    if (!TOKEN()) return { configured: false, reachable: false, message: 'No WhatsApp token is set on this server yet.', serviceCount: 0 };
    if (this.lastStatus && Date.now() - this.lastStatus.at < STATUS_CACHE_MS) return this.lastStatus.value;
    let value: ProviderStatus;
    try {
      const r = await this.rpc('tools/list', {}, LIST_TIMEOUT_MS);
      const n = Array.isArray(r?.tools) ? r.tools.length : 0;
      value = { configured: true, reachable: true, serviceCount: 1, message: `${n} WhatsApp actions.` };
    } catch (e: any) {
      value = { configured: true, reachable: false, serviceCount: 1, message: this.plainError(e) };
    }
    this.lastStatus = { at: Date.now(), value };
    return value;
  }

  /**
   * The one service. Listed with or without the token (the service is ours and statically known),
   * except `connectedOnly`, where an unconfigured provider honestly has nothing.
   */
  async listServices(opts: { connectedOnly?: boolean; search?: string; category?: string; limit?: number } = {}): Promise<ServiceInfo[]> {
    const configured = !!TOKEN();
    if (opts.connectedOnly && !configured) return [];
    if (opts.category && String(opts.category).toLowerCase() !== CATEGORY.id) return [];
    const q = String(opts.search || '').trim().toLowerCase();
    if (q && !WHATSAPP_SERVICE.includes(q) && !'whatsapp messages templates'.includes(q)) return [];
    const actions = await this.ready();
    return [this.toServiceInfo(actions, configured)];
  }

  async getService(slug: string): Promise<ServiceInfo | null> {
    if (String(slug || '').toLowerCase() !== WHATSAPP_SERVICE) return null;
    return this.toServiceInfo(await this.ready(), !!TOKEN());
  }

  async listActions(service: string, opts: { important?: boolean; limit?: number; search?: string } = {}): Promise<ServiceAction[]> {
    if (String(service || '').toLowerCase() !== WHATSAPP_SERVICE) return [];
    const q = String(opts.search || '').trim().toLowerCase();
    let out = (await this.ready()).filter((a) => !q || a.id.includes(q) || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    if (opts.limit && opts.limit > 0) out = out.slice(0, opts.limit);
    return out;
  }

  async getAction(actionId: string): Promise<ServiceAction | null> {
    if (!this.owns(actionId)) return null;
    await this.ready();
    return this.byId.get(String(actionId || '')) || null;
  }

  /**
   * Is this one of ours? By SERVICE, not by list membership, on purpose: `whatsapp` is on the
   * blocked list for the general provider (it is ours), so an unknown `svc:whatsapp.*` id must
   * still land here and fail with our sentence instead of falling through to a provider that
   * refuses the whole service.
   */
  owns(actionId: string): boolean {
    if (!isServiceToolId(actionId)) return false;
    return parseServiceToolId(actionId)?.service === WHATSAPP_SERVICE;
  }

  /** "Connect" is not a login here: the token is provisioned on the server by the owner. */
  async connect(): Promise<ConnectResult> {
    if (TOKEN()) return { ok: true, done: true, connectionId: ACCOUNT.id, status: 'ACTIVE', message: 'WhatsApp is already connected through the server token.' };
    return { ok: false, message: 'WhatsApp runs on a server token that only the owner can set (WHATSAPP_MCP_TOKEN in the deploy secrets). There is nothing to type in here.' };
  }

  async disconnect(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'The WhatsApp token is set on the server — remove it from the deploy secrets to disconnect.' };
  }

  async renameConnection(): Promise<{ ok: boolean; message?: string }> {
    return { ok: false, message: 'There is one server token here, and it has no name to change.' };
  }

  /** On demand: forget the status and re-read the tool list in the background. Never blocks. */
  refresh() {
    this.lastStatus = null;
    if (TOKEN()) this.loading = this.loadTools().catch(() => undefined);
  }

  /**
   * Run one tool: ONE JSON-RPC `tools/call` to the gateway. The MCP answer's text content is
   * parsed back to the tool's own JSON. Never throws.
   *
   * Honesty rule (BEA-1384): the gateway answers `status: "failed"` with the REAL Meta error when
   * a send is refused (outside the 24h window, template not approved) — that is a FAILED step here,
   * with Meta's reason as the sentence, never a success that quietly did not deliver.
   */
  async execute(actionId: string, args: Record<string, any> = {}, opts: { connectionId?: string; timeoutMs?: number } = {}): Promise<ExecuteResult> {
    const started = Date.now();
    if (!this.owns(actionId)) return { ok: false, error: `"${actionId}" is not one of the WhatsApp actions we know.`, ms: 0 };
    if (!TOKEN()) return { ok: false, error: 'WhatsApp is not set up on this server yet — the server token is missing.', ms: 0 };
    const name = parseServiceToolId(actionId)!.action;
    try {
      const r = await this.rpc('tools/call', { name, arguments: args || {} }, opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : CALL_TIMEOUT_MS);
      const ms = Date.now() - started;
      const text = Array.isArray(r?.content) ? r.content.filter((c: any) => c?.type === 'text').map((c: any) => String(c.text ?? '')).join('\n') : '';
      let data: any = text;
      try { data = text ? JSON.parse(text) : undefined; } catch { /* a plain-text answer stays text */ }
      // The MCP protocol's own failure flag: the tool threw, and `text` is its reason.
      if (r?.isError) return { ok: false, error: (text || 'The WhatsApp gateway refused that call.').slice(0, 400), data, ms };
      // The gateway's own verdict on a send: "failed" carries the real WhatsApp/Meta error.
      const verdict = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
      if (verdict && String(verdict.status || '').toLowerCase() === 'failed') {
        const why = String(verdict.error || verdict.message || 'WhatsApp refused it').slice(0, 400);
        return { ok: false, error: `WhatsApp did not deliver it: ${why}`, data, ms };
      }
      return { ok: true, data, ms };
    } catch (e: any) {
      return { ok: false, error: this.plainError(e), ms: Date.now() - started, status: e?.status };
    }
  }

  // ---- shapes ------------------------------------------------------------------------------

  private toServiceInfo(actions: ServiceAction[], configured: boolean): ServiceInfo {
    return {
      slug: WHATSAPP_SERVICE,
      name: 'WhatsApp',
      category: CATEGORY.name,
      categories: [CATEGORY],
      connected: configured,
      accounts: configured ? [ACCOUNT] : [],
      description: actions.length
        ? `${actions.length} actions — send messages and templates, read conversations and replies`
        : 'Send messages and templates, read conversations and replies',
      actionCount: actions.length,
      triggerCount: 0,
      managedAuth: false,
      noAuth: false,
      authSchemes: ['BEARER_TOKEN'],
      authMode: 'BEARER_TOKEN',
      needs: [],
      needsAuthConfig: [],
      needsAccount: [],
    };
  }

  // ---- the wire ----------------------------------------------------------------------------

  /**
   * One JSON-RPC call over streamable HTTP. The server is stateless (one POST per call, no
   * session, no initialize dance) and may answer either plain JSON or a one-event SSE stream —
   * both are handled. Throws on transport, on HTTP and on a JSON-RPC error; the token is never
   * part of anything thrown.
   */
  private async rpc(method: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
    const id = ++this.rpcId;
    const res = await fetch(MCP_URL(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw Object.assign(new Error('The WhatsApp gateway rejected the server token.'), { status: res.status });
    if (!res.ok) throw Object.assign(new Error(`The WhatsApp gateway answered HTTP ${res.status}.`), { status: res.status });
    const message = this.readRpcAnswer(text, id);
    if (!message) throw new Error('The WhatsApp gateway did not answer properly.');
    if (message.error) throw new Error(String(message.error.message || 'The WhatsApp gateway refused that call.').slice(0, 300));
    return message.result;
  }

  /** The JSON-RPC message out of the body — plain JSON, or the `data:` lines of an SSE stream. */
  private readRpcAnswer(body: string, id: number): { result?: any; error?: { message?: string } } | null {
    const text = String(body || '').trim();
    if (!text) return null;
    if (!text.startsWith('event:') && !text.startsWith('data:')) {
      try { return JSON.parse(text); } catch { return null; }
    }
    const messages = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
      .filter(Boolean);
    return messages.find((m: any) => m.id === id) || messages.find((m: any) => m.result !== undefined || m.error !== undefined) || null;
  }

  /** Never leak the token or a stack into anything the owner reads. */
  private plainError(e: any): string {
    if (e?.status === 401 || e?.status === 403) return 'The WhatsApp gateway rejected the server token.';
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'The WhatsApp gateway did not answer in time.';
    return String(e?.message || 'Could not reach the WhatsApp gateway.').slice(0, 200);
  }
}
