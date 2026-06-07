import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';

/** Default bookmarks summarizer — Gemini via OpenRouter (handles YouTube natively). */
const DEFAULT_MODEL = process.env.BOOKMARKS_MODEL || 'google/gemini-3-flash-preview';

export type BookmarkModel = { provider: 'openrouter'; model: string };

/**
 * Summarizes bookmarks for the Bookmarks feature, using its OWN model setting
 * (separate from the app's default AI model). YouTube links are summarized natively
 * by handing the video URL to Gemini through OpenRouter's `video_url` content type.
 */
@Injectable()
export class SummarizerService {
  constructor(
    private readonly connectors: ConnectorService,
    private readonly prisma: PrismaService,
  ) {}

  /** The bookmarks-specific model (falls back to the Gemini default). */
  async getModel(): Promise<BookmarkModel> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'bookmarks.llm' } });
    if (row) {
      try {
        const v = JSON.parse(row.value);
        if (v?.model) return { provider: 'openrouter', model: String(v.model) };
      } catch {
        /* ignore */
      }
    }
    return { provider: 'openrouter', model: DEFAULT_MODEL };
  }

  async setModel(model: string): Promise<void> {
    const value = JSON.stringify({ provider: 'openrouter', model });
    await this.prisma.setting.upsert({ where: { key: 'bookmarks.llm' }, create: { key: 'bookmarks.llm', value }, update: { value } });
  }

  /** Whether the OpenRouter key (which powers Gemini summaries) is configured. */
  async hasKey(): Promise<boolean> {
    const c = await this.connectors.get<{ apiKey: string }>('openrouter');
    return !!c?.apiKey;
  }

  /** Every Gemini model available on OpenRouter (newest first), for the picker. Empty on failure. */
  async listGeminiModels(): Promise<{ id: string; name: string }[]> {
    const c = await this.connectors.get<{ apiKey: string }>('openrouter');
    try {
      const r = await fetch('https://openrouter.ai/api/v1/models', {
        headers: c?.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      });
      if (!r.ok) return [];
      const d: any = await r.json();
      const list: any[] = Array.isArray(d.data) ? d.data : [];
      return list
        .filter((m) => typeof m.id === 'string' && m.id.startsWith('google/gemini'))
        .map((m) => ({ id: m.id as string, name: (m.name as string) || (m.id as string) }))
        .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // gemini-3* before gemini-2*
    } catch {
      return [];
    }
  }

  /** YouTube / Shorts / youtu.be — summarized natively by Gemini (no page read needed). */
  isVideo(url: string): boolean {
    return /(?:youtube\.com\/(?:watch|shorts\/|live\/)|youtu\.be\/)/i.test(url || '');
  }

  private prompt(title: string): string {
    return (
      `Write a clear, self-contained summary in about 250 words (do not exceed 280). ` +
      `Use plain prose — no markdown headings, no bullet lists. Capture what it is about, the key points / tools / steps, ` +
      `and who would find it useful, so it can be found later by meaning.\n\nTitle: ${title}`
    );
  }

  private async call(content: any, maxTokens = 600): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('openrouter');
    if (!c?.apiKey) return null;
    const { model } = await this.getModel();
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }),
      });
      if (!r.ok) return null;
      const d: any = await r.json();
      const text = d?.choices?.[0]?.message?.content;
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    } catch {
      return null;
    }
  }

  /** Hand the YouTube URL straight to Gemini (it watches the video). */
  async summarizeYouTube(url: string, title: string): Promise<string | null> {
    return this.call([
      { type: 'text', text: this.prompt(title) + '\n\nSummarize the linked video.' },
      { type: 'video_url', video_url: { url } },
    ]);
  }

  /** Hand a plain web URL to Gemini to read + summarize. Returns null if it can't access the page. */
  async summarizeUrl(url: string, title: string): Promise<string | null> {
    const text = await this.call(
      `${this.prompt(title)}\n\nRead the web page at this URL and summarize it. ` +
        `If you genuinely cannot access the page, reply with exactly NO_ACCESS and nothing else.\n\nURL: ${url}`,
    );
    if (!text) return null;
    if (text.trim().toUpperCase().startsWith('NO_ACCESS')) return null;
    return text;
  }

  /** Summarize already-extracted page text. */
  async summarizeText(title: string, text: string): Promise<string | null> {
    const doc = (text || '').slice(0, 8000);
    if (!doc.trim()) return null;
    return this.call(`${this.prompt(title)}\n\nContent:\n${doc}`);
  }
}
