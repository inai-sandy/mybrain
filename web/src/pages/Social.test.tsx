import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Social } from './Social';
import { SocialPlatform } from './SocialPlatform';
import { NAV_GROUPS } from '../ui/nav';
import { shapeOf, pickColumns, format, toMarkdown } from './social/resultShape';

/**
 * BEA-1356 — the Social section: sidebar entry, platform grid, platform page, run any endpoint
 * right there. Every state the issue names is pinned: no key, normal, loading, a platform with one
 * endpoint, a form with no parameters, an endpoint that failed (their real words), out of credits
 * (a plain sentence + top-up link, never a raw error), and the spec being unreachable.
 */

const toast = vi.fn();
vi.mock('../ui/Toast', () => ({ useToast: () => toast }));

const PLATFORMS = [
  { slug: 'tiktok', name: 'TikTok', actionCount: 29, tags: ['TikTok', 'TikTok Shop', 'TikTok Ad Library'], kinds: ['profile', 'posts', 'search'], connected: true, description: '29 endpoints' },
  { slug: 'instagram', name: 'Instagram', actionCount: 19, tags: ['Instagram'], kinds: ['profile', 'posts', 'comments'], connected: true },
  { slug: 'linktree', name: 'Linktree', actionCount: 1, tags: ['Linktree'], kinds: ['profile'], connected: true },
  { slug: 'newthing', name: 'New Thing', actionCount: 3, tags: ['New Thing'], kinds: [], connected: true }, // no brand mark → initial tile
];

const OVERVIEW = {
  status: { configured: true, reachable: true, message: '25,100 credits left.' },
  balance: 25100,
  spentToday: 7,
  ceiling: null,
  platforms: PLATFORMS,
  spec: { source: 'live', generatedAt: '2026-08-17T10:00:00Z', opCount: 52, platformCount: 4 },
  topUpUrl: 'https://scrapecreators.com',
};

const SPEND = { status: OVERVIEW.status, balance: 25100, spentToday: 7, ceiling: null, topUpUrl: 'https://scrapecreators.com' };

const ep = (id: string, name: string, tag: string, props: Record<string, any> = {}, required: string[] = [], extra: any = {}) => ({
  id, name, description: `${name} — from the spec.`, service: id.split(':')[1].split('.')[0], method: 'GET', path: '/v1/' + id.split(':')[1].replace('.', '/').replace(/_/g, '/'),
  tags: [tag], schema: { type: 'object', properties: props, ...(required.length ? { required } : {}) }, ...extra,
});

const TIKTOK_ACTIONS = [
  ep('svc:tiktok.profile', 'Get profile', 'TikTok', { handle: { type: 'string', description: 'The @handle', example: 'stoolpresidente' }, cache_max_age: { type: 'string', enum: ['1d', '3d', '7d'] } }, ['handle']),
  ep('svc:tiktok.get_trending_feed', 'Trending feed', 'TikTok', {}), // no inputs
  ep('svc:tiktok.search_keyword', 'Search by keyword', 'TikTok', { query: { type: 'string' }, cursor: { type: 'number' }, date_posted: { type: 'string', enum: ['yesterday', 'this-week'] } }, ['query']),
  ep('svc:tiktok.video_transcript', 'Video transcript', 'TikTok', { url: { type: 'string' } }, ['url'], { costHint: 'Costs 10 credits per request.' }),
  ep('svc:tiktok.shop_search', 'Shop search', 'TikTok Shop', { query: { type: 'string' }, page: { type: 'number' } }, ['query']),
  ep('svc:tiktok.ad_library_search', 'Ad library search', 'TikTok Ad Library', { query: { type: 'string' } }, ['query']),
];

type Mock = { overview?: any; overviewFails?: boolean; platform?: any; run?: (body: any) => any; docs?: any };
function mockFetch(m: Mock = {}) {
  const calls: { url: string; method: string; body?: any }[] = [];
  global.fetch = vi.fn(async (url: any, init: any = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    let body: any = undefined;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ url: u, method, body });
    if (u === '/api/social' || u.startsWith('/api/social?')) {
      if (m.overviewFails) return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => m.overview ?? OVERVIEW };
    }
    if (u === '/api/social/spend') return { ok: true, json: async () => SPEND };
    if (u.startsWith('/api/social/platforms/')) return { ok: true, json: async () => m.platform ?? { platform: PLATFORMS[0], actions: TIKTOK_ACTIONS } };
    if (u === '/api/social/run') return { ok: true, json: async () => (m.run ? m.run(body) : { ok: true, data: { success: true, credits_charged: 1 }, credits: 1, ms: 300 }) };
    if (u === '/api/documents') return { ok: true, json: async () => m.docs ?? { id: 'doc_1' } };
    if (u === '/api/items/upload') return { ok: true, json: async () => ({ ok: true }) };
    return { ok: false, json: async () => ({}) };
  }) as any;
  return calls;
}

function AgentStub() { const loc = useLocation(); return <div data-testid="agent-page" data-search={loc.search}>agent builder</div>; }
const drawGrid = () => render(<MemoryRouter initialEntries={['/social']}><Routes><Route path="/social" element={<Social />} /></Routes></MemoryRouter>);
const drawPlatform = (slug = 'tiktok') => render(
  <MemoryRouter initialEntries={[`/social/${slug}`]}>
    <Routes>
      <Route path="/social/:platform" element={<SocialPlatform />} />
      <Route path="/agent" element={<AgentStub />} />
      <Route path="/doc/:id" element={<div data-testid="doc-page">doc</div>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => { toast.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the sidebar', () => {
  it('has Social under Automation, after Tools', () => {
    const auto = NAV_GROUPS.find((g) => g.label === 'Automation')!;
    const labels = auto.items.map((i) => i.label);
    expect(labels).toEqual(['Agents', 'Flows', 'Skills', 'Tools', 'Social']);
    expect(auto.items.find((i) => i.label === 'Social')!.to).toBe('/social');
  });
});

describe('the platform grid (/social)', () => {
  it('shows a loading skeleton, then every platform with its endpoint count and the credit header', async () => {
    mockFetch();
    drawGrid();
    expect(screen.getByTestId('social-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('platform-card').length).toBe(PLATFORMS.length));
    expect(screen.getByTestId('platform-count').textContent).toBe(String(PLATFORMS.length));
    // counts are the provider's, per card
    const cards = screen.getAllByTestId('platform-card');
    expect(cards.some((c) => c.textContent?.includes('TikTok') && c.textContent?.includes('29 endpoints'))).toBe(true);
    expect(cards.some((c) => c.textContent?.includes('Linktree') && c.textContent?.includes('1 endpoint'))).toBe(true);
    // header: balance · spent today · ceiling ("no limit set" until BEA-1358)
    expect(screen.getByTestId('credit-balance').textContent).toContain('25,100');
    expect(screen.getByTestId('credit-spent').textContent).toBe('7');
    expect(screen.getByTestId('credit-ceiling').textContent).toMatch(/No limit set/);
    // a platform without a brand mark still gets a tile (its initial)
    const nt = cards.find((c) => c.textContent?.includes('New Thing'))!;
    expect(within(nt).getByTestId('platform-logo').textContent).toBe('N');
    // list standards: search + filter + sort + count
    expect(screen.getByLabelText('Search')).toBeTruthy();
    expect(screen.getByLabelText('Has')).toBeTruthy();
    expect(screen.getByLabelText('Sort')).toBeTruthy();
    expect(screen.getByTestId('dt-count').textContent).toContain(`${PLATFORMS.length} results`);
  });

  it('shows the ceiling when one is set', async () => {
    mockFetch({ overview: { ...OVERVIEW, ceiling: 500, spentToday: 120 } });
    drawGrid();
    await waitFor(() => expect(screen.getByTestId('credit-ceiling').textContent).toBe('500'));
    expect(screen.getByTestId('credit-spent').textContent).toBe('120');
  });

  it('no key: a plain message with a link to Settings — and the platforms are still there to browse', async () => {
    mockFetch({ overview: { ...OVERVIEW, status: { configured: false, reachable: false, message: 'No Scrape Creators API key saved yet.' }, balance: null } });
    drawGrid();
    await waitFor(() => expect(screen.getByText(/No Scrape Creators key yet/)).toBeTruthy());
    const link = screen.getByRole('link', { name: /Add the key in Settings/ });
    expect(link.getAttribute('href')).toBe('/settings/connections');
    expect(screen.getByTestId('credit-balance').textContent).toMatch(/No key/);
    expect(screen.getAllByTestId('platform-card').length).toBe(PLATFORMS.length);
  });

  it('spec unreachable: the last-good list is shown with a notice saying so', async () => {
    // `source` stays 'live' after one good read even when the next re-read fails — the notice
    // must key off the error, not the source.
    mockFetch({ overview: { ...OVERVIEW, spec: { source: 'live', generatedAt: '2026-08-16T10:00:00Z', opCount: 52, platformCount: 4, lastError: 'HTTP 503' } } });
    drawGrid();
    await waitFor(() => expect(screen.getByText(/Showing the last good list/)).toBeTruthy());
    expect(screen.getByText(/HTTP 503/)).toBeTruthy();
    expect(screen.getAllByTestId('platform-card').length).toBe(PLATFORMS.length);
  });

  it('a search narrows the grid; a miss says so kindly', async () => {
    mockFetch();
    drawGrid();
    await waitFor(() => screen.getAllByTestId('platform-card'));
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'insta' } });
    expect(screen.getAllByTestId('platform-card').length).toBe(1);
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'myspace' } });
    expect(screen.getByTestId('dt-empty').textContent).toMatch(/No platform matches/);
  });

  it('when the server cannot be reached, says so — never a blank page', async () => {
    mockFetch({ overviewFails: true });
    drawGrid();
    await waitFor(() => expect(screen.getByText(/We could not load Social/)).toBeTruthy());
  });
});

describe('the platform page (/social/:platform)', () => {
  it('shows every endpoint, count == the provider\'s, grouped by the spec\'s tags', async () => {
    mockFetch();
    drawPlatform();
    expect(screen.getByTestId('platform-loading')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByTestId('endpoint-card').length).toBe(TIKTOK_ACTIONS.length));
    expect(screen.getByTestId('endpoint-count').textContent).toBe(`${TIKTOK_ACTIONS.length} endpoints`);
    const groups = screen.getAllByTestId('endpoint-group');
    expect(groups.map((g) => g.querySelector('h2')!.textContent)).toEqual(['TikTok4', 'TikTok Shop1', 'TikTok Ad Library1']);
    // the header strip
    expect(screen.getByTestId('credit-balance').textContent).toContain('25,100');
    // group chips act as the filter
    fireEvent.click(screen.getByRole('button', { name: /TikTok Shop/ }));
    expect(screen.getAllByTestId('endpoint-group').length).toBe(1);
    expect(screen.getAllByTestId('endpoint-card').length).toBe(1);
    // and search
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByLabelText('Search endpoints'), { target: { value: 'transcript' } });
    expect(screen.getAllByTestId('endpoint-card').length).toBe(1);
    expect(screen.getAllByTestId('endpoint-card')[0].textContent).toContain('10 credits');
  });

  it('a platform with one endpoint is just a shorter page', async () => {
    mockFetch({ platform: { platform: PLATFORMS[2], actions: [ep('svc:linktree.get', 'Get Linktree', 'Linktree', { url: { type: 'string' } }, ['url'])] } });
    drawPlatform('linktree');
    await waitFor(() => expect(screen.getAllByTestId('endpoint-card').length).toBe(1));
    expect(screen.getByTestId('endpoint-count').textContent).toBe('1 endpoint');
    // no chip row when there is one group
    expect(screen.queryByRole('group', { name: 'Groups' })).toBeNull();
  });

  it('an unknown platform says so, with a way back', async () => {
    mockFetch({ platform: { platform: null, actions: [], message: 'We do not know a platform called "myspace".' } });
    drawPlatform('myspace');
    await waitFor(() => expect(screen.getByText(/We do not know that platform/)).toBeTruthy());
    expect(screen.getByRole('link', { name: /Back to Social/ })).toBeTruthy();
  });

  it('opens an endpoint: the form is generated from the schema (required first, enums as selects) and Run needs the required ones', async () => {
    const calls = mockFetch({ run: () => ({ ok: true, data: { success: true, credits_charged: 1, data: { user: { username: 'stoolpresidente', full_name: 'Dave', follower_count: 1200000, is_verified: true } } }, credits: 1, ms: 420 }) });
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Get profile/ }));
    const panel = screen.getByTestId('run-panel');
    // required first
    const labels = within(panel).getAllByText(/^(handle|cache_max_age)$/).map((l) => l.textContent);
    expect(labels).toEqual(['handle', 'cache_max_age']);
    expect(within(panel).getByLabelText('cache_max_age').tagName).toBe('SELECT');
    // run without the required field: told, nothing sent
    fireEvent.click(within(panel).getByTestId('run-button'));
    expect(within(panel).getByRole('alert').textContent).toMatch(/Fill in handle first/);
    expect(calls.filter((c) => c.url === '/api/social/run').length).toBe(0);
    // fill + run → the real result renders as a profile card, with the cost
    fireEvent.change(within(panel).getByLabelText('handle'), { target: { value: 'stoolpresidente' } });
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByTestId('run-result')).toBeTruthy());
    const run = calls.find((c) => c.url === '/api/social/run')!;
    expect(run.body).toEqual({ actionId: 'svc:tiktok.profile', args: { handle: 'stoolpresidente' } });
    expect(within(panel).getByTestId('credits-charged').textContent).toContain('1 credit');
    expect(within(panel).getByTestId('result-profile').textContent).toContain('stoolpresidente');
    expect(within(panel).getByTestId('result-profile').textContent).toContain('1,200,000');
    // the three result actions
    expect(within(panel).getByRole('button', { name: /Save as Document/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /Send to Capture/ })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: /Make it an agent/ })).toBeTruthy();
    // the strip is re-read after a run
    expect(calls.filter((c) => c.url === '/api/social/spend').length).toBeGreaterThanOrEqual(2);
  });

  it('a form with no parameters just runs; a cache hit shows "cached · 0"', async () => {
    mockFetch({ run: () => ({ ok: true, data: { success: true, credits_charged: 0, videos: [{ id: '1', desc: 'a video', playCount: 10 }] }, credits: 0, ms: 90 }) });
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Trending feed/ }));
    const panel = screen.getByTestId('run-panel');
    expect(panel.textContent).toMatch(/takes no inputs/);
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByTestId('run-result')).toBeTruthy());
    expect(within(panel).getByTestId('credits-charged').textContent).toContain('cached · 0');
    // a list → a DataTable with its count
    expect(within(panel).getByTestId('result-list')).toBeTruthy();
    expect(within(panel).getByTestId('dt-count').textContent).toContain('1 result');
  });

  it('a list result is a table with search/sort/count/pages, and "load more" follows the cursor', async () => {
    let n = 0;
    const calls = mockFetch({ run: (body) => { n++; return { ok: true, data: { success: true, credits_charged: 1, cursor: n < 3 ? n * 20 : null, videos: Array.from({ length: 12 }, (_, i) => ({ id: `${n}-${i}`, desc: `video ${n}-${i}`, playCount: i, url: 'https://www.tiktok.com/@x/video/' + i })) }, credits: 1, ms: 100, echo: body }; } });
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Search by keyword/ }));
    const panel = screen.getByTestId('run-panel');
    fireEvent.change(within(panel).getByLabelText('query'), { target: { value: 'smart home' } });
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByTestId('result-list')).toBeTruthy());
    expect(within(panel).getByTestId('dt-count').textContent).toContain('12 results');
    // paginated at 10 a page
    expect(within(panel).getByText('1/2')).toBeTruthy();
    // load more → the cursor from the answer goes back, rows append, credits add up
    fireEvent.click(within(panel).getByRole('button', { name: /Load more/ }));
    await waitFor(() => expect(within(panel).getByTestId('dt-count').textContent).toContain('24 results'));
    const runs = calls.filter((c) => c.url === '/api/social/run');
    expect(runs[1].body.args).toEqual({ query: 'smart home', cursor: 20 });
    expect(within(panel).getByTestId('credits-charged').textContent).toContain('2 credits');
    fireEvent.click(within(panel).getByRole('button', { name: /Load more/ }));
    await waitFor(() => expect(within(panel).getByTestId('dt-count').textContent).toContain('36 results'));
    // cursor null → that is everything
    expect(within(panel).queryByRole('button', { name: /Load more/ })).toBeNull();
    expect(panel.textContent).toMatch(/That is everything/);
  });

  it('an endpoint that failed shows their real reason, in plain words', async () => {
    mockFetch({ run: () => ({ ok: false, error: 'TikTok could not do that: No posts found', credits: 0, ms: 200 }) });
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Trending feed/ }));
    const panel = screen.getByTestId('run-panel');
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByRole('alert')).toBeTruthy());
    expect(within(panel).getByRole('alert').textContent).toContain('No posts found');
    expect(within(panel).queryByTestId('run-result')).toBeNull();
  });

  it('their "No posts found" (notFound) is a calm empty state, 0 credits, and "Make it an agent" is still there (BEA-1359)', async () => {
    mockFetch({ run: () => ({ ok: false, error: 'TikTok could not do that: No posts found', credits: 0, ms: 200, notFound: true, status: 404 }) });
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Get profile/ }));
    const panel = screen.getByTestId('run-panel');
    fireEvent.change(within(panel).getByLabelText('handle'), { target: { value: 'smarthomeindia' } });
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByTestId('run-empty')).toBeTruthy());
    expect(within(panel).queryByRole('alert')).toBeNull(); // not a red error
    expect(within(panel).getByTestId('run-empty').textContent).toMatch(/Nothing found for that/);
    expect(within(panel).getByTestId('run-empty').textContent).toMatch(/No posts found/);
    expect(within(panel).getByTestId('run-empty').textContent).toMatch(/0 credits/);
    expect(within(panel).queryByTestId('run-result')).toBeNull();
    // the arguments just used ride into the builder — a schedule is how you keep asking
    fireEvent.click(within(panel).getByRole('button', { name: /Make it an agent/ }));
    await waitFor(() => expect(screen.getByTestId('agent-page')).toBeTruthy());
  });

  it('out of credits: "credits are out" with a top-up link — never the raw refusal', async () => {
    mockFetch({ run: () => ({ ok: false, error: 'Your Scrape Creators credits are out. Top up, then run it again.', outOfCredits: true, topUpUrl: 'https://scrapecreators.com', credits: 0 }) });
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Trending feed/ }));
    const panel = screen.getByTestId('run-panel');
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByText(/Your credits are out/)).toBeTruthy());
    const link = within(panel).getByRole('link', { name: /Top up/ });
    expect(link.getAttribute('href')).toBe('https://scrapecreators.com');
    expect(panel.textContent).not.toMatch(/payment_required|402/);
  });

  it('result actions: Save as Document posts markdown to the documents API; Send to Capture uploads a .md; Make it an agent navigates with the tool id + args', async () => {
    const calls = mockFetch({ run: () => ({ ok: true, data: { success: true, credits_charged: 1, transcript: 'This is a long transcript of the video, with enough words in it to count as prose for the shape detector.' }, credits: 1, ms: 100 }) });
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Video transcript/ }));
    const panel = screen.getByTestId('run-panel');
    fireEvent.change(within(panel).getByLabelText('url'), { target: { value: 'https://www.tiktok.com/@x/video/1' } });
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByTestId('result-transcript')).toBeTruthy());
    expect(within(panel).getByTestId('result-transcript').textContent).toContain('long transcript');

    fireEvent.click(within(panel).getByRole('button', { name: /Send to Capture/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/items/upload' && c.method === 'POST')).toBe(true));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('success', expect.stringMatching(/Capture/)));

    fireEvent.click(within(panel).getByRole('button', { name: /Save as Document/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/documents' && c.method === 'POST')).toBe(true));
    const doc = calls.find((c) => c.url === '/api/documents')!;
    expect(doc.body.title).toBe('TikTok — Video transcript');
    expect(doc.body.kind).toBe('md');
    expect(doc.body.tags).toEqual(['social', 'tiktok']);
    expect(doc.body.contentText).toContain('svc:tiktok.video_transcript');
    expect(doc.body.contentText).toContain('long transcript');
    await waitFor(() => expect(screen.getByTestId('doc-page')).toBeTruthy());
  });

  it('Make it an agent hands the tool id + args + a compact sample over in the URL — to the THINKING builder (builder=chat, BEA-1372)', async () => {
    mockFetch();
    drawPlatform();
    await waitFor(() => screen.getAllByTestId('endpoint-card'));
    fireEvent.click(screen.getByRole('button', { name: /Get profile/ }));
    const panel = screen.getByTestId('run-panel');
    fireEvent.change(within(panel).getByLabelText('handle'), { target: { value: 'legrand_in' } });
    fireEvent.click(within(panel).getByTestId('run-button'));
    await waitFor(() => expect(within(panel).getByTestId('run-result')).toBeTruthy());
    fireEvent.click(within(panel).getByRole('button', { name: /Make it an agent/ }));
    await waitFor(() => expect(screen.getByTestId('agent-page')).toBeTruthy());
    const q = new URLSearchParams(screen.getByTestId('agent-page').getAttribute('data-search') || '');
    expect(q.get('builder')).toBe('chat');
    expect(q.get('tool')).toBe('svc:tiktok.profile');
    expect(JSON.parse(q.get('args')!)).toEqual({ handle: 'legrand_in' });
    expect(JSON.parse(q.get('sample')!)).toMatchObject({ credits: 1 });
  });

  it('no key: the Run button is off and says why, but the endpoints are all still listed', async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      if (u === '/api/social/spend') return { ok: true, json: async () => ({ ...SPEND, status: { configured: false, reachable: false, message: 'No key' }, balance: null }) };
      return { ok: true, json: async () => ({ platform: PLATFORMS[0], actions: TIKTOK_ACTIONS }) };
    }) as any;
    drawPlatform();
    await waitFor(() => expect(screen.getAllByTestId('endpoint-card').length).toBe(TIKTOK_ACTIONS.length));
    expect(screen.getByText(/No Scrape Creators key yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Trending feed/ }));
    expect((screen.getByTestId('run-button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the shape of an answer (resultShape)', () => {
  it('tells a transcript, a list, a profile and plain JSON apart', () => {
    expect(shapeOf({ success: true, credits_charged: 10, transcript: 'x'.repeat(50) }).shape).toBe('transcript');
    expect(shapeOf({ success: true, transcript: [{ text: 'hello there friends and neighbours', start: 0 }, { text: 'and welcome back to the show', start: 2 }] }).shape).toBe('transcript');
    expect(shapeOf({ success: true, posts: [{ url: 'https://x', caption: 'hi', like_count: 3, owner: { username: 'a' } }] })).toMatchObject({ shape: 'list', listKey: 'posts' });
    expect(shapeOf({ success: true, data: { user: { username: 'a', full_name: 'A', follower_count: 1 } } })).toMatchObject({ shape: 'profile', profileKey: 'data.user' });
    expect(shapeOf({ success: true, credits_charged: 1 }).shape).toBe('json');
    expect(shapeOf(null).shape).toBe('json');
  });

  it('picks the columns a person wants first, and surfaces the author', () => {
    const cols = pickColumns([{ id: 'x', shortcode: 's', caption: 'c', like_count: 1, url: 'https://u', owner: { username: 'me' }, is_video: false }]);
    expect(cols[0]).toBe('caption');
    expect(cols).toContain('url');
    expect(cols).toContain('like_count');
    expect(cols).toContain('owner.username');
    expect(cols.length).toBeLessThanOrEqual(6);
  });

  it('formats numbers, hidden counts, epoch dates and links', () => {
    expect(format(1234567).text).toBe('1,234,567');
    expect(format(-1, 'like_count').text).toBe('hidden');
    expect(format(1723900000, 'taken_at').kind).toBe('date');
    expect(format('https://www.instagram.com/p/abc/').href).toBe('https://www.instagram.com/p/abc/');
    expect(format(true).text).toBe('Yes');
    expect(format('').kind).toBe('empty');
  });

  it('writes a list as a markdown table with the endpoint, inputs and cost on top', () => {
    const md = toMarkdown({ title: 'Instagram — Hashtag', endpoint: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, credits: 1, data: { success: true, posts: [{ url: 'https://a', caption: 'one | two', like_count: 5 }] } });
    expect(md).toContain('# Instagram — Hashtag');
    expect(md).toContain('`svc:instagram.search_hashtag`');
    expect(md).toContain('smarthomeindia');
    expect(md).toContain('**Cost:** 1 credit');
    expect(md).toContain('| Caption |');
    expect(md).toContain('one \\| two');
  });
});
