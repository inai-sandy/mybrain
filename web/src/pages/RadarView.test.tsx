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
];

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
