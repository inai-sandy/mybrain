import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RadarView } from './RadarView';

/**
 * BEA-1324 — the v4.1 timeline design.
 *
 * What must not regress: the numbered Hot-now list, the chronological feed with a
 * clock time per story, the expand-in-place story area (reports timeline + links),
 * Curated/All, the chips, the icon-search — and the promises carried over from the
 * earlier issues: translated marker, no score pills, stale-data over blank pages.
 */

vi.mock('./Agents', () => ({ timeAgo: () => '2h ago' }));
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));

const ITEMS = [
  {
    id: 'p1', title: 'State of Open Models', titleOriginal: 'State of Open Models', translated: false,
    url: 'https://x/1', source: 'Hugging Face Blog', category: 'models', aiScore: 0.92,
    sources: [], isPick: true, whyItMatters: 'Shows where open models really get used.', publishedAt: '2026-08-14T08:00:00Z', heat: 1,
  },
  {
    id: 'hot1', title: 'Cursor is acquired by SpaceX', titleOriginal: 'Cursor is acquired by SpaceX', translated: false,
    url: 'https://x/5', source: 'TechCrunch AI', category: 'industry', aiScore: 0.5,
    sources: [
      { name: 'TechCrunch AI', url: 'https://x/5', title: 'Cursor acquired', at: '2026-08-14T09:00:00Z' },
      { name: 'The Verge AI', url: 'https://x/6', title: 'SpaceX buys Cursor', at: '2026-08-14T10:15:00Z' },
      { name: 'hackernews', url: 'https://x/7', at: '2026-08-14T11:00:00Z' },
    ],
    isPick: false, whyItMatters: null, publishedAt: '2026-08-14T09:00:00Z', heat: 3,
  },
  {
    id: 'zh1', title: 'Qwen open-sources a new model', titleOriginal: '通义千问开源新模型', translated: true,
    url: 'https://x/3', source: 'Qwen', category: 'models', aiScore: 0.85,
    sources: [], isPick: false, whyItMatters: null, publishedAt: '2026-08-14T10:00:00Z', heat: 1,
  },
  {
    id: 'low1', title: 'A quiet minor library update', titleOriginal: 'A quiet minor library update', translated: false,
    url: 'https://x/8', source: 'hackernews', category: 'devtools', aiScore: 0.3,
    sources: [], isPick: false, whyItMatters: null, publishedAt: '2026-08-14T11:30:00Z', heat: 1,
  },
];

const STATUS = {
  lastSyncAt: '2026-08-14T17:00:00Z', lastOkAt: '2026-08-14T17:00:00Z', lastError: null,
  total: 4, pendingTranslation: 0, categories: ['models', 'industry', 'devtools'], sources: ['Hugging Face Blog', 'Qwen', 'TechCrunch AI', 'hackernews'],
};

function mockFetch(over: Partial<Record<string, any>> = {}) {
  return vi.fn(async (url: string, init?: any) => {
    const body =
      url.includes('/radar/status') ? (over.status ?? STATUS)
      : url.includes('/radar/sync') ? (over.sync ?? { ok: true, stored: 2, known: 1, translated: 1 })
      : (over.list ?? { items: ITEMS, total: ITEMS.length, page: 1, pageSize: 100, pages: 1 });
    if (over.failAll) return { ok: false, json: async () => ({}) } as any;
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) } as any;
  });
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('prettySource keeps the page English (carried from BEA-1313)', () => {
  it('shows the Latin part of a Chinese source name', async () => {
    const { prettySource } = await import('./RadarView');
    expect(prettySource('X：通义千问 / Qwen (@Alibaba_Qwen)')).toBe('X Qwen (@Alibaba_Qwen)');
    expect(prettySource('公众号：智谱（GLM）')).toBe('GLM');
    expect(prettySource('Hugging Face Blog')).toBe('Hugging Face Blog');
    expect(prettySource('数字生命')).toBe('数字生命');
  });
});

describe('the numbered Hot-now list (BEA-1324)', () => {
  it('shows hot stories numbered by heat, with the flame count', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    expect(await screen.findByText('Hot now · by heat')).toBeTruthy();
    expect(screen.getByText('#1')).toBeTruthy();
    expect(screen.getByText('🔥 3')).toBeTruthy();
    expect(screen.getAllByText('Cursor is acquired by SpaceX').length).toBeGreaterThan(0);
  });
});

describe('the timeline feed (BEA-1324)', () => {
  it('shows the feed with no score pills anywhere', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('Today, hour by hour');
    expect(screen.queryByText('0.92')).toBeNull();
    expect(screen.queryByText('0.85')).toBeNull();
  });

  it('marks the top pick, hot stories, and translated titles', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('Today, hour by hour');
    expect(screen.getByText('★ Top pick')).toBeTruthy();
    expect(screen.getByText('🔥 3 outlets')).toBeTruthy();
    expect(screen.getByText('· translated')).toBeTruthy();
    expect(screen.getByText('Shows where open models really get used.')).toBeTruthy();
  });

  it('a story expands in place to the reports timeline, links and Share', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('Today, hour by hour');
    const expanders = screen.getAllByRole('button', { name: /Story/ });
    const cursorBtn = expanders.find((b) => b.closest('div.relative')?.textContent?.includes('Cursor'));
    fireEvent.click(cursorBtn!);
    await waitFor(() => expect(screen.getByText('⌃ Close')).toBeTruthy());
    const items = screen.getAllByRole('listitem').map((li) => li.textContent || '');
    expect(items[0]).toContain('TechCrunch AI');
    expect(items[2]).toContain('hackernews');
    expect(screen.getAllByText(/↗/).length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText('⤴ Share').length).toBeGreaterThan(0);
  });
});

describe('the controls row (BEA-1324)', () => {
  it('Curated hides the low-value tail; All brings it back', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('Today, hour by hour');
    expect(screen.queryByText('A quiet minor library update')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(screen.getAllByText('A quiet minor library update').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Curated' }));
    await waitFor(() => expect(screen.queryByText('A quiet minor library update')).toBeNull());
  });

  it('a category chip filters the feed but leaves the Hot-now overview alone', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('Today, hour by hour');
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    // The industry hot story leaves the FEED (its 🔥-outlets mark disappears)…
    await waitFor(() => expect(screen.queryByText('🔥 3 outlets')).toBeNull());
    // …but the Hot-now overview still lists it.
    expect(screen.getAllByText('Cursor is acquired by SpaceX').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'All categories' }));
    await waitFor(() => expect(screen.getByText('🔥 3 outlets')).toBeTruthy());
  });

  it('the search icon unfolds a live search field', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('Today, hour by hour');
    fireEvent.click(screen.getByRole('button', { name: 'Search stories' }));
    fireEvent.change(screen.getByPlaceholderText('Search stories…'), { target: { value: 'qwen' } });
    await waitFor(() => expect(screen.queryByText('State of Open Models')).toBeNull());
    expect(screen.getAllByText('Qwen open-sources a new model').length).toBeGreaterThan(0);
  });
});

describe('the public page (BEA-1325)', () => {
  it('publicMode reads the no-login routes and shows no Sync button', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RadarView publicMode />);
    await screen.findByText('Today, hour by hour');
    expect(screen.queryByText('Sync now')).toBeNull();
    const urls = fetchMock.mock.calls.map(([u]: any[]) => String(u));
    expect(urls.some((u) => u.includes('/api/news/public/radar/status'))).toBe(true);
    expect(urls.some((u) => u.startsWith('/api/news/public/radar?'))).toBe(true);
    // Not one call may fall back to the owner-only routes.
    expect(urls.every((u) => !/\/api\/news\/radar(\/|\?|$)/.test(u))).toBe(true);
  });
});

describe('states stay honest (carried from BEA-1313)', () => {
  it('shows the warming-up empty state when the radar has nothing yet', async () => {
    vi.stubGlobal('fetch', mockFetch({ list: { items: [], total: 0, page: 1, pageSize: 100, pages: 1 }, status: { ...STATUS, total: 0 } }));
    render(<RadarView />);
    expect(await screen.findByText('The radar is warming up')).toBeTruthy();
  });

  it('shows our own error words with a retry when nothing could be loaded', async () => {
    vi.stubGlobal('fetch', mockFetch({ failAll: true }));
    render(<RadarView />);
    expect(await screen.findByText('The radar could not be loaded. Check your connection and try again.')).toBeTruthy();
    expect(screen.getByText('Try again')).toBeTruthy();
  });

  it('keeps stale stories on screen with a plain note when the last sync failed', async () => {
    vi.stubGlobal('fetch', mockFetch({ status: { ...STATUS, lastError: 'radar unreachable: HTTP 500' } }));
    render(<RadarView />);
    expect(await screen.findByText(/The last sync hit a problem/)).toBeTruthy();
    expect(screen.getAllByText('State of Open Models').length).toBeGreaterThan(0);
  });

  it('Sync now posts and reports what happened in plain words', async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<RadarView />);
    fireEvent.click(await screen.findByText('Sync now'));
    await waitFor(() => expect(screen.getByText('Synced: 2 new, 1 known, 1 translated.')).toBeTruthy());
    expect(fetchMock.mock.calls.some(([u, init]: any[]) => String(u).includes('/radar/sync') && init?.method === 'POST')).toBe(true);
  });
});
