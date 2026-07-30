import { Injectable, Logger } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';

/**
 * Real web research for a flow (BEA-1194).
 *
 * A "Web search" step used to send the Codex engine a prompt saying "search the web" and let it
 * decide how — which is how a research run came back citing 2021-22 admission figures as proxies
 * for 2025 graduates. Tavily was configured and paid for, and never touched: it appeared in three
 * files, none of them on the flow or engine path.
 *
 * Two tools, two jobs:
 *  • Tavily  — keyword search and page reading. Fast, cited, deterministic.
 *  • Exa     — semantic search: finds pages about an IDEA when you don't know the right words.
 *
 * Both are DIRECT calls, like the brain search already was — no engine turn, so a step returns in
 * seconds instead of minutes. Neither ever falls back to the model: a failure says so, because a
 * quiet fall back to training knowledge is the bug this replaces.
 */

export type WebResult = { title: string; url: string; snippet: string; published?: string };

/** Thrown so the flow marks the step failed WITH the reason, instead of a silent empty answer. */
export class WebSearchError extends Error {}

const TIMEOUT_MS = 20_000;

@Injectable()
export class WebResearchService {
  private readonly log = new Logger('WebResearch');

  constructor(private readonly connectors: ConnectorService) {}

  /**
   * Which search back-ends have a key, asked ONCE.
   *
   * Deep research needs this up front: it must know whether Exa is an option before it starts
   * choosing a back-end per sub-question, rather than discovering it by catching a failure and
   * having to guess whether that failure cost a credit.
   */
  async available(): Promise<{ tavily: boolean; exa: boolean }> {
    const [t, e] = await Promise.all([
      this.connectors.get<{ apiKey?: string }>('tavily').catch(() => null),
      this.connectors.get<{ apiKey?: string }>('exa').catch(() => null),
    ]);
    return { tavily: !!t?.apiKey, exa: !!e?.apiKey };
  }

  /** Does the wording ask for something current? Then weight the last year. */
  static wantsRecent(q: string): boolean {
    const t = String(q || '').toLowerCase();
    if (/\b(20[2-9]\d)\b/.test(t)) return true; // a year was named
    return /\b(latest|recent|current|now|today|this year|upcoming|new|trend|update)\b/.test(t);
  }

  /** Keyword search with citations (Tavily). */
  async search(query: string, max = 6): Promise<WebResult[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const key = (await this.connectors.get<{ apiKey?: string }>('tavily').catch(() => null))?.apiKey;
    if (!key) throw new WebSearchError('Tavily is not connected — add your key in Settings → Connections.');
    // Recent-weighted, never recent-ONLY: a question with no fresh coverage must still return
    // something, it just shouldn't lead with a decade-old page. So if the news window comes back
    // empty, ask exactly once more with the window off.
    //
    // Two attempts, fixed — NOT a retry that rewords the question. A query reads as "recent"
    // either from a word ("latest") or from a year ("placements 2026"), and rewording can only
    // remove the words: on a query with a year it would rebuild the same question and search
    // forever, hanging the step it exists to fail fast.
    const recent = WebResearchService.wantsRecent(q);
    let rows = await this.tavilySearch(key, q, max, recent);
    if (!rows.length && recent) rows = await this.tavilySearch(key, q, max, false);
    return rows.map((x) => ({ title: String(x.title || 'Untitled'), url: String(x.url || ''), snippet: String(x.content || '').slice(0, 900), published: x.published_date || undefined }));
  }

  /** One search call. `recent` narrows it to the last year of news. */
  private async tavilySearch(key: string, q: string, max: number, recent: boolean): Promise<any[]> {
    const body: any = { api_key: key, query: q.slice(0, 380), max_results: Math.min(max, 10), search_depth: 'advanced', include_answer: false };
    if (recent) { body.topic = 'news'; body.days = 365; }
    const r = await this.post('https://api.tavily.com/search', body).catch((e) => {
      this.log.warn(`Tavily search failed to connect: ${e?.message || e}`);
      throw new WebSearchError(`the web search could not run (${e?.message || e})`);
    });
    if (r.status === 429) throw new WebSearchError('Tavily is out of credits or rate-limited right now.');
    if (!r.ok) {
      this.log.warn(`Tavily search returned ${r.status}`);
      throw new WebSearchError(`the web search failed (Tavily said ${r.status}).`);
    }
    const d: any = await r.json().catch(() => ({}));
    return Array.isArray(d?.results) ? d.results : [];
  }

  /** Semantic search — finds pages about the IDEA, not the words (Exa). */
  async searchByMeaning(query: string, max = 6): Promise<WebResult[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const key = (await this.connectors.get<{ apiKey?: string }>('exa').catch(() => null))?.apiKey;
    if (!key) throw new WebSearchError('Exa is not connected — add your key in Settings → Connections.');
    const body: any = {
      query: q.slice(0, 380),
      numResults: Math.min(max, 10),
      type: 'auto',
      contents: { text: { maxCharacters: 900 } },
    };
    if (WebResearchService.wantsRecent(q)) {
      const since = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
      body.startPublishedDate = since;
    }
    const r = await this.post('https://api.exa.ai/search', body, { 'x-api-key': key }).catch((e) => {
      throw new WebSearchError(`the meaning search could not run (${e?.message || e})`);
    });
    // The free plan is rate-limited rather than a fixed quota — say which, so it is actionable.
    if (r.status === 429) throw new WebSearchError('Exa is rate-limited right now (its free plan throttles). Try again shortly, or add a paid key.');
    if (!r.ok) throw new WebSearchError(`the meaning search failed (Exa said ${r.status}).`);
    const d: any = await r.json().catch(() => ({}));
    const rows: any[] = Array.isArray(d?.results) ? d.results : [];
    return rows.map((x) => ({ title: String(x.title || 'Untitled'), url: String(x.url || ''), snippet: String(x.text || x.snippet || '').slice(0, 900), published: x.publishedDate || undefined }));
  }

  /** Read one page properly (Tavily extract). */
  async readPage(url: string): Promise<string> {
    const u = (url.match(/https?:\/\/\S+/) || [])[0];
    if (!u) throw new WebSearchError('no link to read — give the step a URL.');
    const key = (await this.connectors.get<{ apiKey?: string }>('tavily').catch(() => null))?.apiKey;
    if (!key) throw new WebSearchError('Tavily is not connected — add your key in Settings → Connections.');
    const r = await this.post('https://api.tavily.com/extract', { api_key: key, urls: [u] }).catch((e) => {
      throw new WebSearchError(`could not open the page (${e?.message || e})`);
    });
    if (!r.ok) throw new WebSearchError(`could not open the page (Tavily said ${r.status}).`);
    const d: any = await r.json().catch(() => ({}));
    const first = (Array.isArray(d?.results) ? d.results : [])[0];
    const text = String(first?.raw_content || '').trim();
    if (!text) throw new WebSearchError(`that page returned nothing readable (${u}).`);
    return `### ${u}\n\n${text.slice(0, 12000)}`;
  }

  /**
   * The sources, as markdown, for the next step to write from. Keeping the links in the output is
   * what puts them in the saved document — so even if the writing step later fails, the research
   * survives with its sources (BEA-1193).
   */
  asMarkdown(query: string, rows: WebResult[], via: string): string {
    if (!rows.length) return `No sources found for “${query}” (${via}).`;
    const lines = rows.map((r, i) => {
      const when = r.published ? ` · ${String(r.published).slice(0, 10)}` : '';
      return `**[${i + 1}] ${r.title}**${when}\n${r.url}\n\n${r.snippet}`;
    });
    return `Sources found for “${query}” (${via}):\n\n${lines.join('\n\n---\n\n')}`;
  }

  private post(url: string, body: unknown, headers: Record<string, string> = {}) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
}
