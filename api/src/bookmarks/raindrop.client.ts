import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

export type RaindropItem = {
  id: number;
  title: string;
  link: string;
  excerpt: string;
  note: string;
  tags: string[];
  created: string; // ISO
  cover: string; // page cover image (may be empty)
};

const BASE = process.env.RAINDROP_BASE || 'https://api.raindrop.io/rest/v1';

/** Reads bookmarks from the user's Raindrop account (key from the Connector Registry). */
@Injectable()
export class RaindropClient {
  constructor(private readonly connectors: ConnectorService) {}

  async hasKey(): Promise<boolean> {
    const c = await this.connectors.get<{ token: string }>('raindrop');
    return !!c?.token;
  }

  private async token(): Promise<string> {
    const c = await this.connectors.get<{ token: string }>('raindrop');
    if (!c?.token) throw new Error('Raindrop connector not configured');
    return c.token;
  }

  /**
   * All bookmarks created within the last `sinceDays` days, newest first.
   * Walks pages (newest-first) and stops as soon as it crosses the cutoff.
   */
  async recent(sinceDays = 90, cap = 1000): Promise<RaindropItem[]> {
    const token = await this.token();
    const cutoff = Date.now() - sinceDays * 86400000;
    const out: RaindropItem[] = [];
    // collection 0 = "all" across every Raindrop collection.
    for (let page = 0; page < 100 && out.length < cap; page++) {
      const url = `${BASE}/raindrops/0?perpage=50&page=${page}&sort=-created`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        if (page === 0) throw new Error(`Raindrop ${res.status}`);
        break;
      }
      const d: any = await res.json();
      const items: any[] = d.items || [];
      if (items.length === 0) break;
      let crossed = false;
      for (const it of items) {
        const createdMs = Date.parse(it.created || '');
        if (Number.isFinite(createdMs) && createdMs < cutoff) {
          crossed = true;
          break;
        }
        out.push({
          id: it._id,
          title: String(it.title || it.link || 'Untitled').trim(),
          link: String(it.link || '').trim(),
          excerpt: String(it.excerpt || '').trim(),
          note: String(it.note || '').trim(),
          tags: Array.isArray(it.tags) ? it.tags.map((t: any) => String(t)) : [],
          created: it.created || new Date(0).toISOString(),
          cover: String(it.cover || '').trim(),
        });
      }
      if (crossed) break;
    }
    return out;
  }

  /** Lightweight auth check used by the Settings "Test" button path. */
  async me(): Promise<{ ok: boolean }> {
    const token = await this.token();
    const res = await fetch(`${BASE}/user`, { headers: { Authorization: `Bearer ${token}` } });
    return { ok: res.ok };
  }
}
