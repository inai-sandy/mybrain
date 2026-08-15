import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import RadarPublic from './RadarPublic';

/**
 * BEA-1325 — the public AI News Daily page at /radar.
 *
 * What must not regress: the /paper-style masthead, the timeline rendered from the
 * NO-LOGIN routes, no Sync button anywhere, and the footer link to the tweets paper.
 */

vi.mock('./Agents', () => ({ timeAgo: () => '2h ago' }));
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));

const ITEMS = [
  {
    id: 'p1', title: 'State of Open Models', titleOriginal: 'State of Open Models', translated: false,
    url: 'https://x/1', source: 'Hugging Face Blog', category: 'models', aiScore: 0.92,
    sources: [], isPick: true, whyItMatters: 'Why line.', publishedAt: '2026-08-15T08:00:00Z', heat: 1,
  },
];

afterEach(() => vi.unstubAllGlobals());

describe('the public AI News Daily page (BEA-1325)', () => {
  it('shows the masthead and the timeline from the public routes, with no admin controls', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const body = url.includes('/status')
        ? { lastOkAt: '2026-08-15T07:00:00Z', total: 1, categories: ['models'], sources: ['Hugging Face Blog'] }
        : { items: ITEMS, total: 1, page: 1, pageSize: 100, pages: 1 };
      return { ok: true, json: async () => JSON.parse(JSON.stringify(body)) } as any;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<RadarPublic />);
    expect(screen.getByText('AI news from around the world, hour by hour')).toBeTruthy();
    expect(await screen.findByText('Today, hour by hour')).toBeTruthy();
    expect(screen.getAllByText('State of Open Models').length).toBeGreaterThan(0);

    // Owner-only controls stay off this page, and only the public routes are called.
    expect(screen.queryByText('Sync now')).toBeNull();
    const urls = fetchMock.mock.calls.map(([u]: any[]) => String(u));
    expect(urls.every((u) => u.includes('/api/news/public/radar'))).toBe(true);

    const paperLink = screen.getByText('AI Tweets Daily') as HTMLAnchorElement;
    expect(paperLink.getAttribute('href')).toBe('/paper');
  });
});
