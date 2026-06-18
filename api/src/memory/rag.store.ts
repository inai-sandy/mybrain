import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

const RAG_URL = process.env.RAG_MCP_URL || 'http://rag-mcp:8050/sse';

/**
 * Content longer than this is saved with `save_chunked_doc` (heading-aware passages,
 * each embedded) instead of a single whole-doc embedding. The rag-mcp embed step caps
 * input at 8000 chars, so a long doc saved whole loses everything past ~8000 chars —
 * chunking is what keeps the tail of long research/docs searchable. (BEA-330)
 */
const CHUNK_THRESHOLD = 2000;

// The MCP SDK is ESM-only. Load it via a real dynamic import that TypeScript
// won't downlevel to require() (which would throw ERR_REQUIRE_ESM at runtime).
const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

/** Self-hosted RAG store — the on-server RAG MCP (rag-mcp), reached over MCP/SSE. */
@Injectable()
export class RagStore implements OnModuleDestroy {
  private readonly log = new Logger('RagStore');
  private client: any = null;
  private connecting: Promise<any> | null = null;

  /** Open one MCP/SSE client. Overridable in tests. */
  protected async createClient(): Promise<any> {
    const { Client } = await dynImport('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await dynImport('@modelcontextprotocol/sdk/client/sse.js');
    const client = new Client({ name: 'mybrain', version: '0.1.0' }, { capabilities: {} });
    const transport = new SSEClientTransport(new URL(RAG_URL));
    await client.connect(transport);
    // Drop the cached client if the connection closes, so the next call reconnects.
    client.onclose = () => {
      if (this.client === client) this.client = null;
    };
    return client;
  }

  /**
   * Lazily connect once and REUSE the client across calls (no connect/close per call —
   * that connection churn was the main RAG latency source). Concurrent first-callers
   * share one in-flight connect. (BEA-330)
   */
  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = this.createClient()
      .then((c) => {
        this.client = c;
        this.connecting = null;
        return c;
      })
      .catch((e) => {
        this.connecting = null;
        throw e;
      });
    return this.connecting;
  }

  /** Run a tool call on the pooled client; if it throws (dead connection), reconnect once and retry. */
  private async call<T>(fn: (c: any) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.getClient());
    } catch (e) {
      this.log.warn(`RAG call failed, reconnecting once: ${(e as Error)?.message ?? e}`);
      try {
        await this.client?.close?.();
      } catch {
        /* ignore */
      }
      this.client = null;
      return fn(await this.getClient());
    }
  }

  async onModuleDestroy() {
    try {
      await this.client?.close?.();
    } catch {
      /* ignore */
    }
  }

  private textOf(r: any): string {
    return r?.content?.[0]?.text ?? '';
  }
  private parse(r: any): any {
    try {
      return JSON.parse(this.textOf(r));
    } catch {
      return null;
    }
  }

  async save(content: string, title?: string, tags: string[] = []): Promise<string> {
    const name = (content?.length ?? 0) > CHUNK_THRESHOLD ? 'save_chunked_doc' : 'save_doc';
    return this.call(async (c) => {
      const r = await c.callTool({ name, arguments: { content, title, tags } });
      const p = this.parse(r);
      // chunked save returns parent_id; whole-doc save returns id.
      return p?.parent_id ?? p?.id ?? 'saved';
    });
  }

  async delete(id: string): Promise<void> {
    await this.call(async (c) => {
      await c.callTool({ name: 'delete_doc', arguments: { id, doc_id: id } }).catch(() => undefined);
    }).catch(() => undefined);
  }

  /**
   * Search whole-docs AND chunks in parallel, merge into one list, de-dup by source doc
   * (keeping the highest-scoring hit per doc), and sort by score. This is what lets a fact
   * buried near the end of a long doc surface — the chunk for that section is searched too.
   * Shape is kept compatible with MemoryService.normRag (id, title, content, tags, score). (BEA-330)
   */
  async search(query: string, limit = 5): Promise<any[]> {
    return this.call(async (c) => {
      const [whole, chunked] = await Promise.all([
        c
          .callTool({ name: 'search_docs', arguments: { query, limit } })
          .then((r: any) => this.parse(r))
          .catch(() => null),
        c
          .callTool({ name: 'search_chunked_docs', arguments: { query, limit } })
          .then((r: any) => this.parse(r))
          .catch(() => null),
      ]);

      const hits: any[] = [];
      for (const w of whole?.results ?? []) {
        hits.push({
          id: w.id,
          title: w.title,
          content: w.content,
          tags: w.tags ?? [],
          score: w.similarity,
          similarity: w.similarity,
        });
      }
      for (const ch of chunked?.results ?? []) {
        hits.push({
          id: ch.parent_id ?? ch.chunk_id,
          title: ch.parent_title ?? ch.chunk_heading ?? '',
          content: ch.chunk_content,
          tags: ch.parent_tags ?? [],
          score: ch.similarity,
          similarity: ch.similarity,
          heading: ch.chunk_heading ?? undefined,
          isChunk: true,
        });
      }

      // De-dup by source-doc id, keep the best-scoring hit per doc.
      const best = new Map<string, any>();
      for (const h of hits) {
        const key = h.id ?? `anon-${best.size}`;
        const prev = best.get(key);
        if (!prev || (h.score ?? 0) > (prev.score ?? 0)) best.set(key, h);
      }
      return [...best.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
    });
  }
}
