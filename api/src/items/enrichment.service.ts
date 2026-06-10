import { Injectable } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';

export type Enrichment = { summary: string; tags: string[] } | null;

@Injectable()
export class EnrichmentService {
  constructor(private readonly llm: LlmService) {}

  /** Summarise + suggest 3–4 tags via the configured LLM. Returns null if no model set or the call fails. */
  async enrich(title: string, content: string): Promise<Enrichment> {
    const doc = content.slice(0, 6000);
    const prompt =
      `Summarise the document in ONE short sentence and give 3-4 short lowercase topical tags (1-2 words each).\n` +
      `Respond with ONLY JSON: {"summary":"...","tags":["..",".."]}\n\nTitle: ${title}\n\nDocument:\n${doc}`;
    const text = await this.llm.complete(prompt, 300, 'capture-enrich');
    if (!text) return null;
    try {
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const tags = Array.isArray(json.tags)
        ? json.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 4)
        : [];
      return { summary: String(json.summary || '').trim().slice(0, 400), tags };
    } catch {
      return null;
    }
  }
}
