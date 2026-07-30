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

/** What a caller may narrow a search with. Anything omitted is worked out from the question. */
export type SearchOptions = {
  window?: { start_date?: string; end_date?: string; time_range?: string };
  country?: string;
  includeDomains?: string[];
  /**
   * Called once per REAL Tavily request, before it goes out.
   *
   * One question can cost up to three calls now (narrowed → no domains → no date window). Counting
   * questions instead of calls would under-report the bill by up to 3x — and it would do so exactly
   * when the fallbacks fire, which is the case this widening exists for. The honest-spend promise
   * from BEA-1196 only holds if this counts what Tavily actually charges for.
   */
  onAttempt?: () => void;
};

type TavilyFilters = { start_date?: string; end_date?: string; time_range?: string; country?: string; domains?: string[] };

/** Below this, a four-digit number in a research question is far more likely a count than a year. */
const RESEARCH_FROM = 2015;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Countries worth spotting in a question. Tavily takes the full country name. */
const COUNTRIES: [string, string][] = [
  ['\\bindian?\\b', 'india'], ['united states|\\busa?\\b', 'united states'],
  ['united kingdom|\\buk\\b|britain', 'united kingdom'], ['\\bgermany\\b', 'germany'],
  ['\\bfrance\\b', 'france'], ['\\bjapan\\b', 'japan'], ['\\bchina\\b', 'china'],
  ['\\bsingapore\\b', 'singapore'], ['\\baustralia\\b', 'australia'], ['\\bcanada\\b', 'canada'],
  ['\\buae\\b|united arab emirates', 'united arab emirates'],
];

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

  /**
   * Work out the real date window a question is asking for (BEA-1199).
   *
   * We used to send `topic: 'news', days: 365` — and `days` is not even in Tavily's current API
   * reference, it is a news-topic leftover. Tavily takes proper windows: `start_date`/`end_date` as
   * YYYY-MM-DD, or `time_range` for a rolling one. A question naming 2025 and 2026 should search
   * 2025-2026, not "the last year of news".
   *
   * `today` is injected so this is testable without freezing the clock.
   */
  static dateWindow(q: string, today = new Date()): { start_date?: string; end_date?: string; time_range?: string } {
    const t = String(q || '');
    const thisYear = today.getUTCFullYear();
    const named = [...new Set((t.match(/\b(1\d{3}|20\d{2})\b/g) || []).map(Number))].sort((a, b) => a - b);
    // Only years we can actually search. Anything older than RESEARCH_FROM is almost never a year in
    // these questions — "how many 2000 students enrolled" means a headcount — and anything beyond
    // next year has not been published.
    const years = named.filter((y) => y >= RESEARCH_FROM && y <= thisYear + 1);
    // If the question named a year we cannot use, narrow NOTHING. Searching "1990 to 2020" as
    // 2020-only, or "2020 vs 2030 projections" as 2020-only, silently answers a smaller question
    // than the one asked — and the report would never mention that it had been cut down.
    if (named.length && years.length !== named.length) return {};
    if (years.length) {
      const first = years[0];
      const last = years[years.length - 1];
      // A named month narrows further, but only when the question named a single year.
      const m = years.length === 1 ? MONTHS.findIndex((name) => new RegExp(`\\b${name}`, 'i').test(t)) : -1;
      if (m >= 0) {
        const s = Date.UTC(first, m, 1);
        return s > today.getTime() ? {} : { start_date: iso(s), end_date: iso(Math.min(Date.UTC(first, m + 1, 0), today.getTime())) };
      }
      // Never ask for the future — cap the window at today. And if the WHOLE range is still ahead of
      // us, narrow to nothing at all: an inverted window (start after end) matches no page ever
      // written, so a question about next year would come back "no sources" instead of "not yet".
      const startMs = Date.UTC(first, 0, 1);
      const endMs = Math.min(Date.UTC(last, 11, 31), today.getTime());
      if (startMs > endMs) return {};
      return { start_date: iso(startMs), end_date: iso(endMs) };
    }
    if (/\b(today|last 24 hours)\b/i.test(t)) return { time_range: 'day' };
    if (/\bthis week\b/i.test(t)) return { time_range: 'week' };
    if (/\b(this month|last month)\b/i.test(t)) return { time_range: 'month' };
    if (WebResearchService.wantsRecent(t)) return { time_range: 'year' };
    return {};
  }

  /** The country a question is about, when it names one (BEA-1199). */
  static countryOf(q: string): string | undefined {
    const t = String(q || '');
    for (const [pattern, country] of COUNTRIES) if (new RegExp(pattern, 'i').test(t)) return country;
    return undefined;
  }

  /** Keyword search with citations (Tavily). */
  async search(query: string, max = 6, opts: SearchOptions = {}): Promise<WebResult[]> {
    const q = (query || '').trim();
    if (!q) return [];
    const key = (await this.connectors.get<{ apiKey?: string }>('tavily').catch(() => null))?.apiKey;
    if (!key) throw new WebSearchError('Tavily is not connected — add your key in Settings → Connections.');

    const window = opts.window ?? WebResearchService.dateWindow(q);
    const country = opts.country ?? WebResearchService.countryOf(q);
    const domains = (opts.includeDomains || []).slice(0, 300);

    // Narrow first, then widen — at most three attempts, each one deliberate. NOT a loop that
    // rewords the question (that version could never terminate on a query containing a year).
    //
    // The domain fallback matters more than it looks: a wrong domain guess returns nothing, and
    // "nothing" is indistinguishable from "this does not exist anywhere". That is the most
    // expensive mistake this tool can make, so a domain filter never gets the last word. Same for
    // a date window.
    const attempt = (f: TavilyFilters) => { opts.onAttempt?.(); return this.tavilySearch(key, q, max, f); };
    let rows = await attempt({ ...window, country, domains });
    if (!rows.length && domains.length) {
      this.log.warn(`Tavily: nothing within the ${domains.length} chosen site(s) — searching the whole web instead`);
      rows = await attempt({ ...window, country });
    }
    if (!rows.length && (window.start_date || window.time_range)) {
      rows = await attempt({ country });
    }
    return rows.map((x) => ({ title: String(x.title || 'Untitled'), url: String(x.url || ''), snippet: String(x.content || '').slice(0, 900), published: x.published_date || undefined }));
  }

  /** One search call, with whatever narrowing was asked for. */
  private async tavilySearch(key: string, q: string, max: number, f: TavilyFilters): Promise<any[]> {
    const body: any = {
      api_key: key,
      query: q.slice(0, 380),
      max_results: Math.min(max, 20),
      search_depth: 'advanced',
      chunks_per_source: 3, // advanced only — brings back more of each page
      include_answer: false,
    };
    if (f.start_date) body.start_date = f.start_date;
    if (f.end_date) body.end_date = f.end_date;
    if (f.time_range) body.time_range = f.time_range;
    if (f.country) body.country = f.country;
    if (f.domains?.length) body.include_domains = f.domains;
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
