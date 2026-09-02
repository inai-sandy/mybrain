import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from './Dashboard';

/**
 * BEA-1597 — a team row on the Dashboard: the reason line is the inbox's own label, and Reply
 * opens the shared sheet IN PLACE; a reply goes out through /reply and the strip re-reads /api/home.
 */
const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual: any = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../ui/TodayCard', () => ({ TodayCard: () => null }));
vi.mock('../ui/markdown', () => ({ Markdown: ({ children }: any) => <div>{children}</div> }));

const HOME = {
  today: { dumped: true, storyDone: false, counts: { total: 3, done: 1, open: 2 }, mustDos: [] },
  insights: { streak: 1, followThrough: 50, minutesSpent: 0, daySummary: null },
  personality: { unlocked: false, summary: null, daysCovered: 0, minDays: 7 },
  counts: { documents: 0, bookmarks: 0, ideas: 0, skills: 0, notes: 0, contacts: 0, meetings: 0, emoCards: 0 },
  facts: { needsYou: { needsYou: 1, toReview: 0, missedToday: 0, overdue: 0 }, yourDay: { open: 2, doneToday: 1, carriedOver: 0, dumped: true, storyDone: false }, owed: { delegatedOpen: 0, stalling: 0, dailyIn: 0, dailyOwed: 0, restDay: false, remindersQueued: 0 } },
  needsYou: [
    {
      kind: 'team', icon: '💬', title: 'Deepthi: Need 298usd for the Elleys PCB advance sir', sub: 'asked for money', href: '/tasks?tab=review', action: 'Reply',
      update: { id: 'u1', text: 'Need 298usd for the Elleys PCB advance sir', label: 'asked for money', contact: { id: 'c1', name: 'Deepthi' }, canReply: true },
    },
  ],
  cooking: [],
  recent: [],
};

function mockFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith('/api/home')) return { ok: true, json: async () => HOME } as any;
    if (u.startsWith('/api/usage')) return { ok: true, json: async () => ({ totalCost: 0 }) } as any;
    return { ok: true, json: async () => ({ ok: true }) } as any;
  }) as any;
  return calls;
}

beforeEach(() => {
  navigate.mockReset();
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  window.scrollTo = vi.fn() as any;
});

describe('Dashboard — Needs you team rows (BEA-1597)', () => {
  it('shows the reason line under the row, and a plain tap on the text goes to the Needs you tab', async () => {
    mockFetch();
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    const row = await screen.findByTestId('need-team');
    expect(row).toHaveTextContent('asked for money');
    fireEvent.click(screen.getByText(/Deepthi: Need 298usd/));
    expect(navigate).toHaveBeenCalledWith('/tasks?tab=review');
  });

  it('Reply opens the shared sheet in place; a sent reply uses /reply and the strip refetches /api/home', async () => {
    const calls = mockFetch();
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByTestId('need-team');
    const homeCallsBefore = calls.filter((c) => c.url.startsWith('/api/home')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    expect(navigate).not.toHaveBeenCalled(); // in place, not a hop
    const sheet = await screen.findByTestId('reply-sheet');
    expect(sheet).toHaveTextContent('Reply to Deepthi');
    expect(screen.getByTestId('reply-sheet-reason')).toHaveTextContent('asked for money');
    fireEvent.change(screen.getByPlaceholderText(/Reply to Deepthi/), { target: { value: 'Approved' } });
    fireEvent.click(screen.getByRole('button', { name: /Send on WhatsApp/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/reminders/review/u1/reply')).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/home')).length).toBeGreaterThan(homeCallsBefore));
  });

  it('Close from the sheet goes through /close and refetches too', async () => {
    const calls = mockFetch();
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await screen.findByTestId('need-team');
    const before = calls.filter((c) => c.url.startsWith('/api/home')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    await screen.findByTestId('reply-sheet');
    fireEvent.click(screen.getByRole('button', { name: /Sorted, close it/ }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/reminders/review/u1/close')).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/api/home')).length).toBeGreaterThan(before));
  });
});
