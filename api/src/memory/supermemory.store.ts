import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

const BASE = process.env.SUPERMEMORY_BASE || 'https://api.supermemory.ai';

/** SuperMemory containerTags allow only [a-z0-9_:-] (no spaces). Make a tag safe. */
export function safeContainerTag(t: string): string {
  return String(t)
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** SuperMemory (cloud) store — primary. Key from the Connector Registry. */
@Injectable()
export class SuperMemoryStore {
  constructor(private readonly connectors: ConnectorService) {}

  private async creds() {
    const c = await this.connectors.get<{ apiKey: string; project: string }>('supermemory');
    if (!c?.apiKey) throw new Error('SuperMemory connector not configured');
    return c;
  }

  async save(content: string, tags: string[] = []): Promise<string> {
    const { apiKey, project } = await this.creds();
    const containerTags = [project, ...tags.map(safeContainerTag).filter(Boolean)];
    const res = await fetch(`${BASE}/v3/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, containerTags, metadata: { tags: tags.join(', ') } }),
    });
    if (!res.ok) throw new Error(`SuperMemory save ${res.status}: ${await res.text()}`);
    const d: any = await res.json();
    return d.id;
  }

  /** Browse existing SuperMemory documents (the user's whole cloud memory). */
  async list(limit = 50, page = 1): Promise<{ total: number; docs: any[] }> {
    const { apiKey, project } = await this.creds();
    const res = await fetch(`${BASE}/v3/documents/list`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit, page, containerTags: [project] }),
    });
    if (!res.ok) return { total: 0, docs: [] };
    const d: any = await res.json();
    const mems = d.memories || [];
    const docs = mems.map((m: any) => ({
      id: m.id,
      title: m.title && m.title !== 'Untitled Document' ? m.title : m.summary ? String(m.summary).slice(0, 70) + '…' : 'Untitled',
      summary: m.summary || '',
      tags: m.metadata?.tags
        ? String(m.metadata.tags).split(',').map((t: string) => t.trim()).filter(Boolean)
        : (m.containerTags || []).filter((t: string) => t !== project),
      createdAt: m.createdAt,
      status: m.status,
      url: m.url || null,
    }));
    return { total: d.pagination?.totalItems ?? docs.length, docs };
  }

  async delete(id: string): Promise<void> {
    const { apiKey } = await this.creds();
    await fetch(`${BASE}/v3/documents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${apiKey}` },
    }).catch(() => undefined);
  }

  async search(q: string, limit = 5): Promise<any[]> {
    const { apiKey } = await this.creds();
    const res = await fetch(`${BASE}/v3/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q, limit }),
    });
    if (!res.ok) throw new Error(`SuperMemory search ${res.status}`);
    const d: any = await res.json();
    return d.results || [];
  }
}
