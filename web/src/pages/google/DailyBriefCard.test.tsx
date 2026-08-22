import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('./GmailRequests', () => ({ RequestsSection: () => null }));

import { DailyBriefCard } from './panels';

/**
 * BEA-1399 — opening the Gmail page shows what the scheduled passes STORED. It never calls Gmail on
 * its own; before this, an unwritten "today" was built the moment the page opened (two Gmail calls +
 * a model call per open). A Refresh is an explicit tap, counted like any call.
 */
afterEach(() => cleanup());

const EMPTY_TODAY = { day: '2026-08-22', unread: null, overview: '', summary: null, sections: [], items: [], generated: false, generatedAt: null };
const BUILT = { ...EMPTY_TODAY, unread: 4, summary: 'Built', overview: 'Built', sections: [{ heading: 'H', points: ['p'], link: null }], items: [], generated: true, generatedAt: '2026-08-22T15:30:00Z' };

describe('DailyBriefCard (BEA-1399)', () => {
  const calls: { url: string; method: string }[] = [];
  beforeEach(() => {
    calls.length = 0;
    global.fetch = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method || 'GET' });
      if (u.startsWith('/api/google/gmail/brief/generate')) return { ok: true, json: async () => BUILT } as any;
      if (u.startsWith('/api/google/gmail/brief')) return { ok: true, json: async () => EMPTY_TODAY } as any;
      return { ok: false, json: async () => ({}) } as any;
    }) as any;
  });

  it('an unwritten today is NOT built on open — it says when the brief is written and offers Refresh now', async () => {
    render(<DailyBriefCard />);
    const note = await screen.findByTestId('brief-schedule-note');
    expect(note.textContent).toMatch(/21:00/);
    expect(note.textContent).toMatch(/23:30/);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url.includes('/brief/generate'))).toHaveLength(0);
    expect(screen.getByRole('button', { name: /refresh now/i })).toBeTruthy();
  });

  it('Refresh now is the explicit, counted call', async () => {
    render(<DailyBriefCard />);
    const btn = await screen.findByRole('button', { name: /refresh now/i });
    fireEvent.click(btn);
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/brief/generate') && c.method === 'POST')).toHaveLength(1));
    await screen.findByText('Built');
  });
});
