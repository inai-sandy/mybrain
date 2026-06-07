import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

const BASE = process.env.TAVILY_BASE || 'https://api.tavily.com';

/** Reads the readable text of a web page via Tavily (key from the Connector Registry). */
@Injectable()
export class TavilyClient {
  constructor(private readonly connectors: ConnectorService) {}

  async hasKey(): Promise<boolean> {
    const c = await this.connectors.get<{ apiKey: string }>('tavily');
    return !!c?.apiKey;
  }

  /** Return the page's readable text, or null if it can't be read (paywall, login, video, dead link…). */
  async extract(url: string): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('tavily');
    if (!c?.apiKey) return null;
    try {
      const res = await fetch(`${BASE}/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: c.apiKey, urls: [url] }),
      });
      if (!res.ok) return null;
      const d: any = await res.json();
      const first = (d.results || [])[0];
      const text = String(first?.raw_content || '').trim();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }
}
