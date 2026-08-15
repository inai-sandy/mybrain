import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
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

// Nothing from the router is stubbed: the pages are SEPARATE routes now (BEA-1321), so
// the toggle's real navigation inside MemoryRouter is exactly what these tests exercise.
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
// The Daily feed has its own tests; here it only needs to be present, not to fetch.
vi.mock('./RadarView', () => ({ RadarView: () => <div>daily-radar-feed</div> }));

const STORIES = Array.from({ length: 12 }, (_, i) => ({
  id: `s${i + 1}`,
  headline: i === 0 ? 'DeepSeek launches V4-Flash public beta' : null,
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

// AI Tweets Daily is its own page now (BEA-1321) — these are its tests, entered at its URL.
const show = () => render(<MemoryRouter initialEntries={['/news/tweets']}><News /></MemoryRouter>);

beforeEach(() => mockFetch());
afterEach(() => vi.restoreAllMocks());

describe('the edition page (BEA-1260)', () => {
  it('puts EVERY story in the page at first render, not just the visible few', async () => {
    show();
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    // All twelve, including the nine behind "9 more" — present before anything is clicked.
    // Story 1 renders its WRITTEN headline; the rest fall back to their first sentence.
    expect(screen.getByText('DeepSeek launches V4-Flash public beta')).toBeTruthy();
    for (let i = 2; i <= 12; i++) {
      expect(screen.getByText(new RegExp(`Story number ${i} about`))).toBeTruthy();
    }
  });

  it('shows the WRITTEN headline when there is one, and the first sentence when there is not', async () => {
    // The API was already returning the written headline and this page ignored it, so the public
    // paper read well and the owner's own page still showed thirty words of narrative.
    show();
    await waitFor(() => expect(screen.getByText('DeepSeek launches V4-Flash public beta')).toBeTruthy());
    expect(screen.getByText(/Story number 2 about/)).toBeTruthy();
  });

  it('shows the hero with the day, the issue number and the count', async () => {
    show();
    // The hero splits "Issue No. 4" across elements, so match the bolded number itself.
    await waitFor(() => expect(screen.getByText('No. 4')).toBeTruthy());
    expect(screen.getAllByText(/stories/).length).toBeGreaterThan(0);
    expect(screen.getByText(/all shown/)).toBeTruthy();
    expect(screen.getByText('Past editions ›')).toBeTruthy();
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
    // Share renders twice on purpose — the hero row (phone) and the rail card (desktop).
    await waitFor(() => expect(screen.getAllByText(/Share this edition/).length).toBeGreaterThan(0));
    for (const btn of screen.getAllByRole('button', { name: /Share this edition/i })) {
      expect(btn.getAttribute('aria-label')).toContain('AI Tweets Daily');
    }
    for (const link of screen.getAllByText('see the public version')) {
      expect(link.getAttribute('href')).toBe('/paper/2026-07-31');
      expect(link.getAttribute('href')).not.toContain('/news/');
    }
  });

  it('offers both ways of reading it', async () => {
    show();
    await waitFor(() => expect(screen.getByText('Category')).toBeTruthy());
    expect(screen.getByText('Where it came from')).toBeTruthy();
  });
});

describe('the two separate pages (BEA-1321)', () => {
  const showBothPages = async (entry: string) => {
    const { Routes, Route } = await vi.importActual<any>('react-router-dom');
    const { default: NewsDaily } = await import('./NewsDaily');
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/news" element={<NewsDaily />} />
          <Route path="/news/tweets" element={<News />} />
          <Route path="/news/:day" element={<News />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('/news is the AI News Daily page with the page-switcher toggle', async () => {
    await showBothPages('/news');
    expect(await screen.findByText('daily-radar-feed')).toBeTruthy();
    expect(screen.getByText('AI News Daily')).toBeTruthy();
    expect(screen.getByText('Tweets')).toBeTruthy();
  });

  it('legacy one-page links keep working: ?view=twitter lands on Tweets, ?view=radar on Daily', async () => {
    await showBothPages('/news?view=twitter');
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    expect(screen.queryByText('daily-radar-feed')).toBeNull();
    cleanup();
    await showBothPages('/news?view=radar');
    expect(await screen.findByText('daily-radar-feed')).toBeTruthy();
  });

  it('a bare day URL opens that edition, never the Daily feed', async () => {
    // Every "Read it" link the pipeline has ever written is /news/<day> with no ?view —
    // those links must keep opening the edition they point at.
    await showBothPages('/news/2026-07-31');
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    expect(screen.queryByText('daily-radar-feed')).toBeNull();
  });

  it('the top Share hands out the PUBLIC /radar link, never the private /news URL (BEA-1330)', async () => {
    const write = vi.fn(async (_text: string) => {});
    Object.assign(navigator, { clipboard: { writeText: write } });
    await showBothPages('/news');
    await screen.findByText('daily-radar-feed');
    fireEvent.click(screen.getByText('Share public link'));
    await waitFor(() => expect(write).toHaveBeenCalled());
    const shared = String(write.mock.calls[0][0]);
    expect(shared).toContain('/radar');
    expect(shared).not.toContain('/news');
  });

  it('the toggle navigates between the two pages', async () => {
    await showBothPages('/news');
    await screen.findByText('daily-radar-feed');
    fireEvent.click(screen.getByText('Tweets'));
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    fireEvent.click(screen.getByText('Daily'));
    expect(await screen.findByText('daily-radar-feed')).toBeTruthy();
  });
});

describe('the archive (BEA-1260)', () => {
  it('a failed load says so and offers a retry — it does NOT pretend there are no editions', async () => {
    // "No past editions yet" and "we could not reach the server" look identical to a reader, and
    // only one of them is true.
    mockFetch({ archiveFails: true });
    show();
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    fireEvent.click(screen.getByText('Past editions ›'));
    await waitFor(() => expect(screen.getByText(/archive could not be loaded/i)).toBeTruthy());
    expect(screen.getByText('Try again')).toBeTruthy();
    expect(screen.queryByText(/No past editions yet/)).toBeNull();
  });

  it('a genuinely empty archive says the friendly thing instead', async () => {
    mockFetch({ archive: [] });
    show();
    await waitFor(() => expect(screen.getByText(/DeepSeek resets the price war/)).toBeTruthy());
    fireEvent.click(screen.getByText('Past editions ›'));
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
