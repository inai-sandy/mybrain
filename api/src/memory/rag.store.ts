import { Injectable } from '@nestjs/common';

const RAG_URL = process.env.RAG_MCP_URL || 'http://rag-mcp:8050/sse';

// The MCP SDK is ESM-only. Load it via a real dynamic import that TypeScript
// won't downlevel to require() (which would throw ERR_REQUIRE_ESM at runtime).
const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

/** Self-hosted RAG store — the on-server RAG MCP (rag-mcp), reached over MCP/SSE. */
@Injectable()
export class RagStore {
  private async withClient<T>(fn: (c: any) => Promise<T>): Promise<T> {
    const { Client } = await dynImport('@modelcontextprotocol/sdk/client/index.js');
    const { SSEClientTransport } = await dynImport('@modelcontextprotocol/sdk/client/sse.js');
    const client = new Client({ name: 'mybrain', version: '0.1.0' }, { capabilities: {} });
    const transport = new SSEClientTransport(new URL(RAG_URL));
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private textOf(r: any): string {
    return r?.content?.[0]?.text ?? '';
  }

  async save(content: string, title?: string, tags: string[] = []): Promise<string> {
    return this.withClient(async (c) => {
      const r = await c.callTool({ name: 'save_doc', arguments: { content, title, tags } });
      try {
        return JSON.parse(this.textOf(r)).id ?? 'saved';
      } catch {
        return 'saved';
      }
    });
  }

  async delete(id: string): Promise<void> {
    await this.withClient(async (c) => {
      await c.callTool({ name: 'delete_doc', arguments: { id, doc_id: id } }).catch(() => undefined);
    }).catch(() => undefined);
  }

  async search(query: string, limit = 5): Promise<any[]> {
    return this.withClient(async (c) => {
      const r = await c.callTool({ name: 'search_docs', arguments: { query, limit } });
      try {
        const parsed = JSON.parse(this.textOf(r));
        return Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
      } catch {
        return [];
      }
    });
  }
}
