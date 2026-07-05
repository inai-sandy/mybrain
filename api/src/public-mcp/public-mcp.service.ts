import { Injectable } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { DocumentsService } from '../documents/documents.service';
import { EmoRouterService } from '../emo/emo-router.service';
import { OAuthService } from '../oauth/oauth.service';

const TOKEN_KEY = 'mcp.public.token';
const ENABLED_KEY = 'mcp.public.enabled';
const WRITE_KEY = 'mcp.public.write'; // opt-in: lets the token CREATE via the capture tool (BEA-872)
const PROTOCOL_VERSION = '2025-06-18';

/** Read-only tools exposed to third-party agents over the public MCP endpoint (BEA-631). */
const TOOLS = [
  { name: 'search_brain', description: "Search the owner's whole second brain (notes, documents, saved memories) by meaning — RAG + SuperMemory, merged and ranked.", inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'search_rag', description: "Search only the owner's RAG vector store (raw, no SuperMemory).", inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'fetch_document', description: "Fetch the full text of one of the owner's documents by id (the id from a search result's document URL).", inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

/** Write tools — only exposed when the owner opts in (mcp.public.write). File a spoken line into Emo. (BEA-872) */
const WRITE_TOOLS = [
  { name: 'capture', description: "File a spoken note into the owner's Emo section. The AI routes it automatically: a to-do becomes a task, 'remind <person>…' a reminder, a reflection a story moment, 'research…' a research flow, otherwise a note. Use whenever the owner wants to CREATE, save, remind, note, or add something by voice.", inputSchema: { type: 'object', properties: { transcript: { type: 'string', description: 'What the owner said, verbatim.' } }, required: ['transcript'] } },
];

type Rpc = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: any };

/**
 * PublicMcpService (BEA-631) — a read-only, token-gated MCP server that lets THIRD-PARTY agents
 * (Claude Desktop, ChatGPT, n8n, …) search the owner's brain over HTTPS. Stateless Streamable-HTTP:
 * each POST is a JSON-RPC request answered with a single JSON response. Distinct from the internal
 * `mybrain` MCP that serves My Brain's own agent.
 */
@Injectable()
export class PublicMcpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly documents: DocumentsService,
    private readonly emoRouter: EmoRouterService,
  ) {}

  private async getSetting(key: string): Promise<string | null> {
    const r = await this.prisma.setting.findUnique({ where: { key } }).catch(() => null);
    return (r as any)?.value ?? null;
  }
  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  /** The token, minted on first use so there's always one to show in settings. */
  async ensureToken(): Promise<string> {
    let tok = await this.getSetting(TOKEN_KEY);
    if (!tok) { tok = 'mbk_' + randomBytes(24).toString('hex'); await this.setSetting(TOKEN_KEY, tok); }
    return tok;
  }
  async isEnabled(): Promise<boolean> {
    return (await this.getSetting(ENABLED_KEY)) === '1';
  }
  async isWriteEnabled(): Promise<boolean> {
    return (await this.getSetting(WRITE_KEY)) === '1';
  }
  async setWriteEnabled(on: boolean) {
    await this.setSetting(WRITE_KEY, on ? '1' : '0');
    return this.config();
  }
  /** The tool set on offer — write tools appear only when the owner opts in. */
  private async toolList() {
    return (await this.isWriteEnabled()) ? [...TOOLS, ...WRITE_TOOLS] : [...TOOLS];
  }

  /** Settings surface for the owner (behind session auth). */
  async config() {
    const [token, enabled, write] = await Promise.all([this.ensureToken(), this.isEnabled(), this.isWriteEnabled()]);
    const tools = write ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;
    return { enabled, write, token, url: 'https://mybrain.1site.ai/api/mcp', tools: tools.map((t) => ({ name: t.name, description: t.description })) };
  }
  async setEnabled(enabled: boolean) {
    await this.setSetting(ENABLED_KEY, enabled ? '1' : '0');
    return this.config();
  }
  async regenerate() {
    const tok = 'mbk_' + randomBytes(24).toString('hex');
    await this.setSetting(TOKEN_KEY, tok);
    return this.config();
  }

  /**
   * Validate a presented bearer token and that the endpoint is enabled. Accepts EITHER the
   * legacy static token (mbk_…) OR an OAuth access token issued via the connector flow (BEA-758).
   */
  async authorize(presented: string | undefined): Promise<boolean> {
    if (!presented || !(await this.isEnabled())) return false;
    // OAuth access token (signed JWT, aud "mcp").
    if (OAuthService.verifyAccess(presented)) return true;
    // Legacy static token — constant-time compare.
    const real = await this.ensureToken();
    const a = Buffer.from(presented);
    const b = Buffer.from(real);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Handle one JSON-RPC message; returns the response object, or null for notifications. */
  async handleRpc(msg: Rpc): Promise<any | null> {
    const id = msg?.id ?? null;
    const ok = (result: any) => ({ jsonrpc: '2.0', id, result });
    const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (!msg?.method) return null;
    // notifications carry no id and expect no response
    if (msg.method.startsWith('notifications/')) return null;

    switch (msg.method) {
      case 'initialize':
        return ok({ protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mybrain-rag', version: '1.0.0' } });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: await this.toolList() });
      case 'tools/call': {
        try {
          const text = await this.runTool(msg.params?.name, msg.params?.arguments || {});
          return ok({ content: [{ type: 'text', text }] });
        } catch (e: any) {
          return ok({ content: [{ type: 'text', text: 'Tool error: ' + (e?.message || String(e)) }], isError: true });
        }
      }
      default:
        return err(-32601, `Method not found: ${msg.method}`);
    }
  }

  private async runTool(name: string, args: any): Promise<string> {
    if (name === 'search_brain' || name === 'search_rag') {
      const q = String(args.query || '').trim();
      if (!q) return 'Provide a query.';
      const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 30);
      const hits = name === 'search_rag' ? await this.memory.searchRag(q, limit) : await this.memory.searchBrain(q, limit);
      if (!hits.length) return 'No matching memory found.';
      return hits.map((h, i) => {
        const docId = h.url && /\/documents\//.test(h.url) ? `  (document id: ${h.url.split('/').pop()})` : '';
        return `${i + 1}. [${h.source}] ${h.title || 'untitled'}${docId}\n${(h.content || '').replace(/\s+/g, ' ').slice(0, 600)}`;
      }).join('\n\n');
    }
    if (name === 'fetch_document') {
      const id = String(args.id || '').trim();
      if (!id) return 'Provide a document id.';
      const doc: any = await this.documents.get(id).catch(() => null);
      if (!doc) return 'No document found with that id.';
      return `# ${doc.title || 'Untitled'}\n\n${(doc.contentText || doc.content || '').slice(0, 12000)}`;
    }
    if (name === 'capture') {
      if (!(await this.isWriteEnabled())) return 'Capture is not enabled on this connector.';
      const t = String(args.transcript || args.text || '').trim();
      if (!t) return 'Provide what to capture.';
      const out = await this.emoRouter.route(t, { source: 'emo-voice' });
      const cards: any[] = out?.cards || [];
      if (!cards.length) return 'Saved as a note in your Emo section.';
      const byLane: Record<string, number> = {};
      for (const c of cards) byLane[c.lane] = (byLane[c.lane] || 0) + 1;
      const parts = Object.entries(byLane).map(([lane, n]) => `${n} ${lane}${n > 1 ? 's' : ''}`);
      return `Done — filed ${parts.join(', ')} in your Emo section.`;
    }
    return `Unknown tool: ${name}`;
  }
}
