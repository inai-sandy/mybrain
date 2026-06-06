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
