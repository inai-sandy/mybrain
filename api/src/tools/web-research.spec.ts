import { WebResearchService, WebSearchError } from './web-research.service';

/**
 * BEA-1194 — "Web search" never touched Tavily. It asked the Codex engine to search, the engine
 * decided how, and a research run came back citing 2021-22 admissions as proxies for 2025 graduates.
 * These pin the two things that must now hold: it really calls the search API, and a failure SAYS SO
 * rather than quietly handing back model knowledge.
 */
function svc(keys: Record<string, string> = { tavily: 't-key', exa: 'e-key' }, reply?: (url: string, body: any) => any) {
  const connectors: any = { get: async (n: string) => (keys[n] ? { apiKey: keys[n] } : null) };
  const s = new WebResearchService(connectors);
  (global as any).fetch = async (url: string, init: any) => reply!(url, JSON.parse(init.body));
  return s;
}
const ok = (json: any) => ({ ok: true, status: 200, json: async () => json });

describe('real web research (BEA-1194)', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });

  it('calls Tavily and returns the sources with their links', async () => {
    let called = '';
    const s = svc(undefined, (url) => { called = url; return ok({ results: [{ title: 'COEP placements 2026', url: 'https://coep.ac.in/p', content: '92% placed' }] }); });
    const rows = await s.search('COEP placement 2026');
    expect(called).toBe('https://api.tavily.com/search');
    expect(rows[0]).toMatchObject({ title: 'COEP placements 2026', url: 'https://coep.ac.in/p' });
    expect(s.asMarkdown('COEP placement 2026', rows, 'web search')).toContain('https://coep.ac.in/p');
  });

  it('weights recent when a year or "latest" is asked for', () => {
    expect(WebResearchService.wantsRecent('placement data 2026')).toBe(true);
    expect(WebResearchService.wantsRecent('latest hiring trends')).toBe(true);
    expect(WebResearchService.wantsRecent('how do induction motors work')).toBe(false);
  });

  it('calls Exa for a meaning search, with its own key header', async () => {
    let seen: any = null;
    const connectors: any = { get: async (n: string) => ({ apiKey: n === 'exa' ? 'e-key' : 't-key' }) };
    const s = new WebResearchService(connectors);
    (global as any).fetch = async (url: string, init: any) => { seen = { url, headers: init.headers }; return ok({ results: [{ title: 'Fresher hiring trends', url: 'https://x.com/a', text: 'AI is reshaping entry roles' }] }); };
    const rows = await s.searchByMeaning('what is changing for fresh graduates in India');
    expect(seen.url).toBe('https://api.exa.ai/search');
    expect(seen.headers['x-api-key']).toBe('e-key');
    expect(rows[0].title).toBe('Fresher hiring trends');
  });

  it('says so when a key is missing, instead of returning nothing', async () => {
    const s = svc({}, () => ok({}));
    await expect(s.search('x')).rejects.toThrow(/Tavily is not connected/);
    await expect(s.searchByMeaning('x')).rejects.toThrow(/Exa is not connected/);
  });

  it('names rate-limiting rather than looking empty', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    (global as any).fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    await expect(s.search('x')).rejects.toThrow(/out of credits or rate-limited/);
    await expect(s.searchByMeaning('x')).rejects.toThrow(/rate-limited/);
  });

  // The review caught this before it shipped: the first version retried by deleting words like
  // "latest". A question is also "recent" because of a YEAR in it, which no rewording removes — so
  // "placements 2026" with no news coverage searched itself in a circle, hanging the very step that
  // exists to fail fast. A bounded number of attempts is the whole guarantee.
  //
  // BEA-1199 changed WHAT the narrowing is (a real start_date/end_date window instead of the
  // undocumented news-only `days`), but not that it must stop.
  it('gives up after one unfiltered retry when a date window finds nothing', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    const bodies: any[] = [];
    (global as any).fetch = async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return ok({ results: [] }); };
    const rows = await s.search('COEP placement 2026');
    expect(rows).toEqual([]);
    expect(bodies).toHaveLength(2);              // not 3, and certainly not forever
    expect(bodies[0].start_date).toBe('2026-01-01');   // the year the question named
    expect(bodies[1].start_date).toBeUndefined();      // second try drops the window
    expect(bodies[1].query).toBe('COEP placement 2026'); // the question itself is never reworded
  });

  it('does not retry at all when the question was never about recent things', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    let calls = 0;
    (global as any).fetch = async () => { calls++; return ok({ results: [] }); };
    expect(await s.search('how do induction motors work')).toEqual([]);
    expect(calls).toBe(1);
  });

  it('never returns an empty string as if it were an answer', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    (global as any).fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    await expect(s.search('x')).rejects.toBeInstanceOf(WebSearchError);
  });
});

/**
 * BEA-1199 — the owner pointed out we were barely using Tavily. We sent `topic: news, days: 365`,
 * and `days` is not even in Tavily's current API reference. A question that names 2025 and 2026
 * should search 2025-2026.
 */
describe('search narrowing (BEA-1199)', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });
  const today = new Date('2026-07-30T00:00:00Z');
  const W = (q: string) => WebResearchService.dateWindow(q, today);

  it('turns the years in a question into a real date window', () => {
    expect(W('placements in 2025 and 2026')).toEqual({ start_date: '2025-01-01', end_date: '2026-07-30' });
  });
  it('never asks for the future — the window stops at today', () => {
    expect(W('what will happen in 2028')).toEqual({});           // wholly in the future → no window at all
    expect(W('the March 2028 launch')).toEqual({});               // same for a future month
    expect(W('hiring in 2026')!.end_date).toBe('2026-07-30');
  });
  it('narrows to the month when one year and one month are named', () => {
    expect(W('the March 2026 announcement')).toEqual({ start_date: '2026-03-01', end_date: '2026-03-31' });
  });
  it('does not narrow to a month when the question spans years', () => {
    expect(W('March intake for 2025 and 2026').start_date).toBe('2025-01-01');
  });
  it('uses a rolling window when the wording is vague about time', () => {
    expect(W('the latest hiring trends')).toEqual({ time_range: 'year' });
    expect(W('what happened this week')).toEqual({ time_range: 'week' });
    expect(W('news today')).toEqual({ time_range: 'day' });
  });
  it('does not narrow a timeless question at all', () => {
    expect(W('how do induction motors work')).toEqual({});
  });

  it('spots the country a question is about', () => {
    expect(WebResearchService.countryOf('fresher hiring in India')).toBe('india');
    expect(WebResearchService.countryOf('UK graduate schemes')).toBe('united kingdom');
    expect(WebResearchService.countryOf('how do motors work')).toBeUndefined();
  });

  it('sends the window, the country and more of each page', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    let body: any = null;
    (global as any).fetch = async (_u: string, init: any) => { body = JSON.parse(init.body); return ok({ results: [{ title: 'T', url: 'https://a', content: 'c' }] }); };
    await s.search('engineering placements in India 2026');
    expect(body.start_date).toBe('2026-01-01');
    expect(body.country).toBe('india');
    expect(body.chunks_per_source).toBe(3);
    expect(body.search_depth).toBe('advanced');
    expect(body.days).toBeUndefined();          // the undocumented news-only leftover is gone
  });

  /**
   * The one that matters most. A wrong domain guess returns nothing, and "nothing" is
   * indistinguishable from "this data does not exist anywhere" — which the owner has just spent a
   * day establishing IS true for his report. A filter must never get the last word.
   */
  it('searches the whole web when the chosen sites come back empty', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    const bodies: any[] = [];
    (global as any).fetch = async (_u: string, init: any) => {
      const b = JSON.parse(init.body); bodies.push(b);
      return ok({ results: b.include_domains ? [] : [{ title: 'Found anyway', url: 'https://x', content: 'c' }] });
    };
    const rows = await s.search('engineering placements 2026', 6, { includeDomains: ['aicte-india.org'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Found anyway');
    expect(bodies[0].include_domains).toEqual(['aicte-india.org']);
    expect(bodies[1].include_domains).toBeUndefined();
  });

  it('keeps the chosen sites when they do return something', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    let calls = 0;
    (global as any).fetch = async () => { calls++; return ok({ results: [{ title: 'T', url: 'https://a', content: 'c' }] }); };
    await s.search('placements 2026', 6, { includeDomains: ['aicte-india.org'] });
    expect(calls).toBe(1);
  });
});

/** Review findings on BEA-1199, fixed before shipping. */
describe('date window edge cases the review caught (BEA-1199)', () => {
  const today = new Date('2026-07-30T00:00:00Z');
  const W = (q: string) => WebResearchService.dateWindow(q, today);

  // "how many 2000 students enrolled" is a headcount, not the year 2000.
  it('does not treat a bare count as a year', () => {
    expect(W('how many 2000 students enrolled this year')).toEqual({});
    expect(W('a college with 1500 seats')).toEqual({});
  });

  // Narrowing "1990 to 2020" down to 2020 answers a smaller question than the one asked, silently.
  it('narrows nothing when the question names a year it cannot search', () => {
    expect(W('compare placements from 1990 to 2020')).toEqual({});
    expect(W('compare 2020 with 2030 projections')).toEqual({});
  });

  it('still narrows when every year named is searchable', () => {
    expect(W('placements in 2025 and 2026')).toEqual({ start_date: '2025-01-01', end_date: '2026-07-30' });
  });

  it('reports every real request it makes, so spend can be counted honestly', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    let attempts = 0, http = 0;
    (global as any).fetch = async (_u: string, init: any) => {
      http++;
      const b = JSON.parse(init.body);
      return ok({ results: b.include_domains || b.start_date ? [] : [{ title: 'T', url: 'https://a', content: 'c' }] });
    };
    await s.search('placements 2026', 6, { includeDomains: ['x.org'], onAttempt: () => { attempts++; } });
    expect(http).toBe(3);            // narrowed → no domains → no window
    expect(attempts).toBe(http);     // and every one was reported
  });
});
