import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RadarView } from './RadarView';

/**
 * BEA-1313 — the Radar tab.
 *
 * What must not regress: picks show their engine line (or say plainly that it is
 * coming), translated titles carry their marker, a radar problem shows stale data
 * with a note instead of a blank page, and the empty/error states speak our words.
 */

// timeAgo lives in the Agents page; importing the real one would drag that whole
// page's dependency graph into this test for a one-line formatter.
vi.mock('./Agents', () => ({ timeAgo: () => '2h ago' }));

const ITEMS = [
  {
    id: 'p1', title: 'State of Open Models', titleOriginal: 'State of Open Models', translated: false,
    url: 'https://x/1', source: 'Hugging Face Blog', category: 'models', aiScore: 0.92,
    sources: [{ name: 'Hugging Face Blog', url: 'https://x/1' }, { name: 'The Verge AI', url: 'https://x/2' }],
    isPick: true, whyItMatters: 'Shows where open models really get used.', publishedAt: '2026-08-14T08:00:00Z',
  },
  {
    id: 'p2', title: 'Qwen open-sources a new model', titleOriginal: '通义千问开源新模型', translated: true,
    url: 'https://x/3', source: 'Qwen', category: 'models', aiScore: 0.85,
    sources: [], isPick: true, whyItMatters: null, publishedAt: '2026-08-14T09:00:00Z',
  },
  {
    id: 's1', title: 'GitHub agent apps walkthrough', titleOriginal: 'GitHub agent apps walkthrough', translated: false,
    url: 'https://x/4', source: 'GitHub AI & ML', category: 'devtools', aiScore: 0.87,
    sources: [], isPick: false, whyItMatters: null, publishedAt: '2026-08-14T10:00:00Z',
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
    id: 'low1', title: 'A quiet minor library update', titleOriginal: 'A quiet minor library update', translated: false,
    url: 'https://x/8', source: 'hackernews', category: 'devtools', aiScore: 0.3,
    sources: [], isPick: false, whyItMatters: null, publishedAt: '2026-08-14T11:30:00Z', heat: 1,
  },
].map((i) => ({ heat: 1, ...i }));

const STATUS = {
  lastSyncAt: '2026-08-14T17:00:00Z', lastOkAt: '2026-08-14T17:00:00Z', lastError: null,
  total: 3, pendingTranslation: 0, categories: ['models', 'devtools'], sources: ['Hugging Face Blog', 'Qwen', 'GitHub AI & ML'],
};

const SITES = { sites: [{ site_id: 'a', site_name: 'Official AI Updates', ok: true, item_count: 172, error: null }, { site_id: 'b', site_name: 'Community', ok: false, item_count: 0, error: 'timeout' }] };

function mockFetch(over: Partial<Record<string, any>> = {}) {
  return vi.fn(async (url: string, init?: any) => {
    const body =
      url.includes('/radar/status') ? (over.status ?? STATUS)
      : url.includes('/radar/sources') ? (over.sites ?? SITES)
      : url.includes('/radar/sync') ? (over.sync ?? { ok: true, stored: 2, known: 1, translated: 1 })
      : (over.list ?? { items: ITEMS, total: ITEMS.length, page: 1, pageSize: 100, pages: 1 });
    if (over.failAll) return { ok: false, json: async () => ({}) } as any;
    return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) } as any;
  });
}

beforeEach(() => vi.useRealTimers());
afterEach(() => vi.unstubAllGlobals());

describe('QA polish stays fixed (BEA-1313)', () => {
  it('never shows a 0.00 score pill — the brief has no scores', async () => {
    vi.stubGlobal('fetch', mockFetch({ list: { items: [{ ...ITEMS[0], aiScore: 0 }], total: 1, page: 1, pageSize: 100, pages: 1 } }));
    render(<RadarView />);
    await screen.findByText('Today’s picks');
    expect(screen.queryByText('0.00')).toBeNull();
  });

  it('shows the Latin part of a Chinese source name', async () => {
    const { prettySource } = await import('./RadarView');
    expect(prettySource('X：通义千问 / Qwen (@Alibaba_Qwen)')).toBe('X Qwen (@Alibaba_Qwen)');
    expect(prettySource('公众号：智谱（GLM）')).toBe('GLM');
    expect(prettySource('Hugging Face Blog')).toBe('Hugging Face Blog');
    // A fully-Chinese name keeps its original — a blank chip helps nobody.
    expect(prettySource('数字生命')).toBe('数字生命');
  });
});

describe('Hot now, Curated/All and the timeline (BEA-1323)', () => {
  it('multi-source stories appear under Hot now with their heat', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    expect(await screen.findByText('Hot now')).toBeTruthy();
    expect(screen.getByText('🔥 3 sources')).toBeTruthy();
    expect(screen.getAllByText('Cursor is acquired by SpaceX').length).toBeGreaterThan(0);
  });

  it('the timeline expands to show who reported it, in order, with links', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('Hot now');
    fireEvent.click(screen.getByText('Timeline · 3 reports ›'));
    const items = screen.getAllByRole('listitem').map((li) => li.textContent || '');
    const inTimeline = items.filter((t) => /TechCrunch AI|The Verge AI|hackernews/.test(t));
    expect(inTimeline.length).toBe(3);
    // Time order: TechCrunch first, hackernews last.
    expect(inTimeline[0]).toContain('TechCrunch AI');
    expect(inTimeline[2]).toContain('hackernews');
  });

  it('Curated hides the low-value tail; All brings it back', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('All stories');
    // Curated is the default — the 0.3-score single-source story is not in the list.
    expect(screen.queryByText('A quiet minor library update')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(screen.getAllByText('A quiet minor library update').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Curated' }));
    await waitFor(() => expect(screen.queryByText('A quiet minor library update')).toBeNull());
  });
});

describe('the mockup chrome drives the list (BEA-1320)', () => {
  it('a category chip filters the stories with one tap', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('All stories');
    // Both categories start visible (models pick + devtools story).
    expect(screen.getAllByText('GitHub agent apps walkthrough').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    // The devtools story leaves the LIST; the picks section above is curated and stays.
    await waitFor(() => expect(screen.queryAllByText('GitHub agent apps walkthrough')).toHaveLength(0));
    fireEvent.click(screen.getByRole('button', { name: 'All categories' }));
    await waitFor(() => expect(screen.getAllByText('GitHub agent apps walkthrough').length).toBeGreaterThan(0));
  });

  it('the search pill narrows the stories', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    await screen.findByText('All stories');
    fireEvent.change(screen.getByPlaceholderText('Search stories…'), { target: { value: 'github' } });
    await waitFor(() => expect(screen.queryAllByText(/Qwen open-sources/)).toHaveLength(1)); // only the pick card remains
    expect(screen.getAllByText('GitHub agent apps walkthrough').length).toBeGreaterThan(0);
  });
});

describe('the Radar tab shows picks, stories, and health (BEA-1313)', () => {
  it('renders the picks with their lines, the table, and the sources strip', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    expect(await screen.findByText('Today’s picks')).toBeTruthy();
    expect(screen.getByText('Shows where open models really get used.')).toBeTruthy();
    // A pick still waiting for its line says so instead of sitting blank.
    expect(screen.getByText('The one-line note arrives within the hour.')).toBeTruthy();
    expect(screen.getByText('All stories')).toBeTruthy();
    expect(screen.getAllByText('GitHub agent apps walkthrough').length).toBeGreaterThan(0);
    // Merged story badge and the health strip.
    expect(screen.getAllByText('+1 sources').length).toBeGreaterThan(0);
    expect(screen.getByText('Official AI Updates')).toBeTruthy();
    expect(screen.getByText('3 stories · synced 2h ago')).toBeTruthy();
  });

  it('marks a translated title and keeps the original in the tooltip', async () => {
    vi.stubGlobal('fetch', mockFetch());
    render(<RadarView />);
    const marks = await screen.findAllByText('translated');
    expect(marks.length).toBeGreaterThan(0);
    expect(marks[0].closest('span[title]')?.getAttribute('title')).toContain('通义千问开源新模型');
  });

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
    await waitFor(() => expect(screen.getByText('Synced: 2 new, 1 already known, 1 translated.')).toBeTruthy());
    expect(fetchMock.mock.calls.some(([u, init]: any[]) => String(u).includes('/radar/sync') && init?.method === 'POST')).toBe(true);
  });
});
