import { Injectable, BadRequestException } from '@nestjs/common';
import { DocumentsService } from '../documents/documents.service';
import { MemoryService } from '../memory/memory.service';
import { AgentService, WaitKind } from './agent.service';

export type SaveDocInput = { title: string; content: string; tags?: string[]; collectionId?: string | null; kind?: string; remember?: boolean; runId?: string };
export type SearchBrainInput = { query: string; limit?: number };
export type AskUserInput = { runId: string; question: string; kind?: WaitKind; options?: unknown; defaultValue?: string; expiresInMs?: number };

/**
 * AgentToolsService (BEA-622) — the My Brain capabilities the agent calls during a run.
 * These are exposed to Hermes over MCP (see agent-mcp) and over REST for the in-app run.
 * Secrets/credentials stay here on the server — only these shaped results reach the model.
 */
@Injectable()
export class AgentToolsService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly memory: MemoryService,
    private readonly agent: AgentService,
  ) {}

  /**
   * describe — the MCP server + tools the agent has, for the settings panel (BEA-627).
   * Single source of truth: the host MCP server (mybrain-mcp) exposes exactly these, proxied here.
   */
  describe() {
    return {
      server: 'mybrain',
      transport: 'stdio · node',
      registeredWith: 'Codex',
      items: [
        { name: 'search_brain', desc: 'Read your whole second brain — notes, documents and saved memories' },
        { name: 'save_document', desc: 'Write a markdown document into your Documents library' },
        { name: 'remember', desc: 'Save a durable fact into your long-term memory' },
      ],
      // Raw connection details for the settings disclosure (BEA-628). These describe the host
      // MCP server the Codex runtime spawns; the app itself is just the endpoint it proxies to.
      connection: {
        command: '/usr/bin/node /home/sandy/mybrain-mcp/server.mjs',
        config: '~/.codex/config.toml [mcp_servers.mybrain]',
        endpoint: 'mybrain.1site.ai/api/agent/tools/*',
        transport: 'stdio · node',
      },
    };
  }

  /** save_document — write the agent's output into the Documents library (versioned, shareable). */
  async saveDocument(input: SaveDocInput) {
    if (!input?.title?.trim() || !input?.content?.trim()) throw new BadRequestException('save_document needs a title and content');
    const doc = await this.documents.create({
      title: input.title,
      contentText: input.content,
      tags: input.tags,
      collectionId: input.collectionId ?? null,
      kind: input.kind || 'md',
    });
    if (input.remember) await this.documents.convertToCapture(doc.id).catch(() => undefined);
    if (input.runId) await this.agent.attachOutput(input.runId, doc.id).catch(() => undefined);
    return { id: doc.id, slug: doc.slug, title: doc.title, url: `/documents/${doc.id}` };
  }

  /** search_brain — read the user's whole second brain (RAG + SuperMemory) for context. */
  async searchBrain(input: SearchBrainInput) {
    const q = (input?.query || '').trim();
    if (!q) throw new BadRequestException('search_brain needs a query');
    const limit = Math.min(Math.max(input.limit ?? 8, 1), 30);
    const hits = await this.memory.searchBrain(q, limit);
    return {
      query: q,
      results: hits.map((h) => ({
        title: h.title,
        snippet: (h.content || '').slice(0, 500),
        source: h.source,
        when: h.when ?? null,
        url: h.url ?? null,
        tags: h.tags ?? [],
      })),
    };
  }

  /** ask_user — pause the run on a DURABLE structured question (survives restart) and return its token. */
  async askUser(input: AskUserInput) {
    if (!input?.runId) throw new BadRequestException('ask_user needs a runId');
    const wp = await this.agent.ask(input.runId, {
      question: input.question,
      kind: input.kind,
      options: input.options,
      defaultValue: input.defaultValue,
      expiresInMs: input.expiresInMs,
    });
    return {
      waitpointId: wp.id,
      token: wp.resumeToken,
      status: wp.status, // 'pending' — the run is now awaiting_input
      note: 'The run is paused durably. Poll get_answer with this token, or the run will be resumed when the user replies.',
    };
  }

  /** remember — write a durable fact straight into the user's memory (RAG + SuperMemory). */
  async remember(input: { text: string; tags?: string[] }) {
    const text = (input?.text || '').trim();
    if (!text) throw new BadRequestException('remember needs some text');
    await this.memory.enqueue(text, { refType: 'agent-memory', title: 'Agent remembered', tags: ['agent', ...(Array.isArray(input.tags) ? input.tags : [])] });
    return { ok: true, remembered: text.slice(0, 120) };
  }

  /** get_answer — fetch the answer to an ask_user question once the user has replied. */
  async getAnswer(token: string) {
    if (!token) throw new BadRequestException('get_answer needs a token');
    const wp = await this.agent.getWaitpoint(token);
    if (!wp) throw new BadRequestException('Unknown token');
    return { status: wp.status, answer: wp.status === 'answered' ? wp.answer : null };
  }
}
