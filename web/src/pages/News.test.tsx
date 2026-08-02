import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import News from './News';

/**
 * BEA-1260 — the edition page.
 *
 * The first test here exists because I got this wrong and said otherwise. The long tail of each
 * section was written as `{expanded && rest.map(…)}`, which does not render those stories at all
 * until someone clicks — so find-in-page could not reach them, and they were gone entirely if
 * scripting broke after first paint. Complete coverage has to mean complete in the PAGE, not
 * complete in the data we happen to hold.
 */

vi.mock('react-router-dom', async () => {
  const actual: any = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn(), useParams: () => ({}) };
});
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));

const STORIES = Array.from({ length: 12 }, (_, i) => ({
  id: `s${i + 1}`,
  text: `Story number ${i + 1} about something that happened.`,
  theme: null,
  category: 'Models & releases',
  sourceKind: 'twitter',
  links: [],
  flagged: false,
}));

const EDITION = {
  number: 4,
  day: '2026-07-31',
  headline: 'DeepSeek resets the price war',
  sixty: ['One thing', 'Another thing'],
  engineOk: true,
  notes: [],
  storyCount: 12,
  shown: 12,
  complete: true,
  sections: [{ category: 'Models & releases', line: 'A busy day', prose: 'Some prose.', written: true, storyCount: 12, stories: STORIES }],
  flagged: [],
  bySource: { twitter: 12 },
  source: { title: 'not much happened today', link: 'https://news.smol.ai/issues/x/', pubDate: '2026-07-31' },
};

function mockFetch(over: Record<string, any> = {}) {
  global.fetch = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/editions/latest')) return { ok: true, json: async () => ({ day: '2026-07-31' }) };
    if (u.includes('/editions/2026-07-31')) return { ok: true, json: async () => over.edition ?? EDITION };
    if (u.endsWith('/editions')) {
      if (over.archiveFails) throw new Error('offline');
      return { ok: true, json: async () => over.archive ?? [] };
    }
    return { ok: true, json: async () => ({}) };
  }) as any;
}

const show = () => render(<MemoryRouter><News /></MemoryRouter>);

beforeEach(() => mockFetch());
afterEach(() => vi.restoreAllMocks());

describe('the edition page (BEA-1260)', () => {
  it('puts EVERY story in the page at first render, not just the visible few', async () => {
    show();
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    // All twelve, including the nine behind "9 more" — present before anything is clicked.
    for (let i = 1; i <= 12; i++) {
      expect(screen.getByText(new RegExp(`Story number ${i} about`))).toBeTruthy();
    }
  });

  it('shows the masthead with the day, the issue number and the count', async () => {
    show();
    await waitFor(() => expect(screen.getByText(/Issue No. 4/)).toBeTruthy());
    expect(screen.getByText(/12 stories/)).toBeTruthy();
    expect(screen.getByText(/all shown/)).toBeTruthy();
  });

  it('says so loudly when the stories on the page do not match the count', async () => {
    mockFetch({ edition: { ...EDITION, storyCount: 40, shown: 12, complete: false } });
    show();
    await waitFor(() => expect(screen.getByText(/do not trust it as complete/)).toBeTruthy());
  });

  it('says which part was not written when the engine failed', async () => {
    mockFetch({ edition: { ...EDITION, engineOk: false, notes: ['Policy & law could not be produced.'] } });
    show();
    await waitFor(() => expect(screen.getByText(/Part of this edition was not written up/)).toBeTruthy());
    expect(screen.getByText(/Policy & law could not be produced/)).toBeTruthy();
  });

  it('says what it is built from, and still links the source issue', async () => {
    // The owner replaced the credit wording on 2026-08-02 (BEA-1265). The LINK stays — one tap to
    // what the source actually wrote is the thing that makes a summary of a summary checkable.
    show();
    await waitFor(() => expect(screen.getByText(/500\+ Twitter accounts and 12 subreddits/)).toBeTruthy());
    expect(screen.getByText(/source issue/).getAttribute('href')).toContain('news.smol.ai');
  });

  it('Share hands over the PUBLIC link, never the private one', async () => {
    // Sending someone /news/<day> gives them a login screen. This is the whole reason the button
    // takes an explicit url instead of reading window.location.
    show();
    await waitFor(() => expect(screen.getByText(/Share this edition/)).toBeTruthy());
    const btn = screen.getByRole('button', { name: /Share this edition/i });
    expect(btn.getAttribute('aria-label')).toContain('AI News Daily');
    const publicLink = screen.getByText('see the public version') as HTMLAnchorElement;
    expect(publicLink.getAttribute('href')).toBe('/paper/2026-07-31');
    expect(publicLink.getAttribute('href')).not.toContain('/news/');
  });

  it('offers both ways of reading it', async () => {
    show();
    await waitFor(() => expect(screen.getByText('Category')).toBeTruthy());
    expect(screen.getByText('Where it came from')).toBeTruthy();
  });
});

describe('the archive (BEA-1260)', () => {
  it('a failed load says so and offers a retry — it does NOT pretend there are no editions', async () => {
    // "No past editions yet" and "we could not reach the server" look identical to a reader, and
    // only one of them is true.
    mockFetch({ archiveFails: true });
    show();
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    fireEvent.click(screen.getByText('Past editions'));
    await waitFor(() => expect(screen.getByText(/archive could not be loaded/i)).toBeTruthy());
    expect(screen.getByText('Try again')).toBeTruthy();
    expect(screen.queryByText(/No past editions yet/)).toBeNull();
  });

  it('a genuinely empty archive says the friendly thing instead', async () => {
    mockFetch({ archive: [] });
    show();
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    fireEvent.click(screen.getByText('Past editions'));
    await waitFor(() => expect(screen.getAllByText(/No past editions yet/).length).toBeGreaterThan(0));
  });
});

describe('when there is nothing to show (BEA-1260)', () => {
  it('an empty state explains when the first edition arrives', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ day: null }) })) as any;
    show();
    await waitFor(() => expect(screen.getByText('No edition yet')).toBeTruthy());
    expect(screen.getByText(/every day at noon/)).toBeTruthy();
  });

  it('a broken edition request shows a real error, not an empty page', async () => {
    global.fetch = vi.fn(async (url: any) =>
      String(url).includes('latest')
        ? { ok: true, json: async () => ({ day: '2026-07-31' }) }
        : { ok: false, json: async () => ({}) },
    ) as any;
    show();
    await waitFor(() => expect(screen.getByText(/could not be opened/)).toBeTruthy());
  });
});
