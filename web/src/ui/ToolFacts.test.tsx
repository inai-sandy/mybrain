import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { factsSummary, healthTone, ToolFacts, ToolKnowledge } from './ToolFacts';

/**
 * BEA-1368 — the Facts fold: closed it costs nothing; opened it reads the card once and says
 * fields · paging · cost · health · notes in plain words.
 */
const CARD: ToolKnowledge = {
  actionId: 'svc:instagram.search_popular',
  name: 'Popular Search',
  service: 'instagram',
  provider: 'social',
  params: [{ name: 'query', required: true }],
  fields: [
    { path: 'posts[].caption', kind: 'text', seen: true, example: 'hi' },
    { path: 'posts[].url', kind: 'url', seen: true },
    { path: 'cursor', kind: 'text', seen: false },
  ],
  hasDateField: false,
  paging: { how: 'cursor', field: 'cursor', pageSize: 12, source: 'spec' },
  cost: { credits: { typical: 1, min: 0, max: 1 }, source: 'observed' },
  health: { ok: false, known: true, successesLast24h: 0, failuresLast24h: 3, emptyLast24h: 3, callsLast30d: 7, lastError: 'No posts found', note: 'Answered not_found (empty answers) for every call since 19:30Z — 3 calls, nothing found.' },
  notes: ['Keys are lowercase on Instagram\'s side.'],
  updatedAt: '2026-08-18T12:00:00.000Z',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('ToolFacts', () => {
  it('does not fetch until opened, then reads the card once and draws every part', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => CARD })) as any;
    vi.stubGlobal('fetch', fetchMock);
    render(<ToolFacts actionId="svc:instagram.search_popular" />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /facts/i }));
    await waitFor(() => expect(screen.getByText(/every call since 19:30Z/)).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/tools/knowledge/svc%3Ainstagram.search_popular');
    expect(screen.getByText(/Usually 1 credit per call \(seen 0–1\)/)).toBeTruthy();
    expect(screen.getByText(/Pages by cursor \(cursor\) · 12 per page/)).toBeTruthy();
    expect(screen.getAllByText(/no date field/i).length).toBeGreaterThan(0);
    expect(screen.getByText('posts[].caption')).toBeTruthy();
    expect(screen.getByText(/lowercase/)).toBeTruthy();
    // Closed and opened again: no second read.
    fireEvent.click(screen.getByRole('button', { name: /facts/i }));
    fireEvent.click(screen.getByRole('button', { name: /facts/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('says so when the card cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })) as any);
    render(<ToolFacts actionId="svc:x.y" />);
    fireEvent.click(screen.getByRole('button', { name: /facts/i }));
    await waitFor(() => expect(screen.getByText(/Could not read the facts/)).toBeTruthy());
  });

  it('the header summary and the health colour come from the card', () => {
    expect(factsSummary(CARD)).toBe('~1 credits (0–1) · pages by cursor · 12/page · no date field');
    expect(factsSummary({ ...CARD, cost: { free: true, source: 'provider' }, paging: { how: 'none', source: 'none' }, hasDateField: true })).toBe('free · one page · has dates');
    expect(healthTone(CARD.health)).toBe('bad');
    expect(healthTone({ ...CARD.health, ok: true })).toBe('ok');
    expect(healthTone({ ...CARD.health, ok: true, known: false })).toBe('quiet');
  });
});
