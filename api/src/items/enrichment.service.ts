import { Injectable } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

export type Enrichment = { summary: string; tags: string[] } | null;

@Injectable()
export class EnrichmentService {
  constructor(
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  /** Summarise + suggest 3–4 tags via the configured LLM. Returns null if no model set or the call fails. */
  async enrich(title: string, content: string): Promise<Enrichment> {
    const doc = content.slice(0, 6000);
    const tmpl = await this.prompts.get('library.captureEnrich');
    const prompt = `${tmpl}\n\nTitle: ${title}\n\nDocument:\n${doc}`;
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
