import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.ANTHROPIC_TAG_MODEL || 'claude-haiku-4-5-20251001';

export type Enrichment = { summary: string; tags: string[] } | null;

@Injectable()
export class EnrichmentService {
  constructor(private readonly connectors: ConnectorService) {}

  /** Summarise + suggest 3–4 tags via Claude Haiku. Returns null if Anthropic isn't set or the call fails. */
  async enrich(title: string, content: string): Promise<Enrichment> {
    const c = await this.connectors.get<{ apiKey: string }>('anthropic');
    if (!c?.apiKey) return null;
    const doc = content.slice(0, 6000);
    const prompt =
      `Summarise the document in ONE short sentence and give 3-4 short lowercase topical tags (1-2 words each).\n` +
      `Respond with ONLY JSON: {"summary":"...","tags":["..",".."]}\n\nTitle: ${title}\n\nDocument:\n${doc}`;
    try {
      const res = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': c.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const text: string = data?.content?.[0]?.text ?? '';
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const tags = Array.isArray(json.tags) ? json.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 4) : [];
      return { summary: String(json.summary || '').trim().slice(0, 400), tags };
    } catch {
      return null;
    }
  }
}
