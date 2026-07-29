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
  // exists to fail fast. Two attempts, fixed, is the whole guarantee.
  it('gives up after one plain retry when the news window is empty — even with a year in the question', async () => {
    const connectors: any = { get: async () => ({ apiKey: 'k' }) };
    const s = new WebResearchService(connectors);
    const bodies: any[] = [];
    (global as any).fetch = async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); return ok({ results: [] }); };
    const rows = await s.search('COEP placement 2026');
    expect(rows).toEqual([]);
    expect(bodies).toHaveLength(2);          // not 3, and certainly not forever
    expect(bodies[0].topic).toBe('news');    // first ask is recent-weighted
    expect(bodies[1].topic).toBeUndefined(); // second drops the window, keeping the question intact
    expect(bodies[1].query).toBe('COEP placement 2026');
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
