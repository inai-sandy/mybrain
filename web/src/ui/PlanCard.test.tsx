import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PlanCard, costLine, creditsText, downText, sourceLine } from './PlanCard';

/**
 * BEA-1372 — the plan-with-cost card. Locks: every section is drawn (fetch · keep · output · when ·
 * notify), a failing source is marked, the cost line shows credits + AI tokens ≈ ₹ with a "how" fold
 * that opens the server's arithmetic, and the three buttons do what they say.
 */
afterEach(() => cleanup());

const PLAN = {
  name: 'Smart home India — Instagram digest',
  sources: [
    { kind: 'source', id: 'svc:instagram.search_hashtag', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, pages: 8 },
    { kind: 'creators', id: 'svc:instagram.search_profiles', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 20 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, keepDays: 30 } },
  ],
  merge: true,
  shape: { prompt: 'Keep only posts about smart home in India. Columns: creator, date, likes, caption, link.' },
  output: { kind: 'sheet', sheetId: null, append: true },
  notify: { whatsapp: true, telegram: false },
  schedule: { schedule: { every: 'week', dow: 1, at: '08:00' }, text: 'every Monday at 08:00' },
  mode: 'run',
};
const COST = { credits: 28, aiTokens: 60_000, items: 200, aiRupees: 18, how: 'Instagram search hashtag: 8 pages × 1 credit = 8 · Instagram search profiles once (1) + 20 creators × 1 credit = 21 → ≈ 29 credits per run; shaping ≈ 200 items × 300 tokens ≈ 60,000 AI tokens ≈ ₹18 (at ₹0.3 per 1k tokens, Sonnet). Sheet writes are not Social credits.', unhealthy: [{ actionId: 'svc:instagram.search_hashtag', name: 'Instagram · Hashtag Search', note: 'not_found for every call in the last 18 h' }] };

describe('PlanCard (BEA-1372)', () => {
  it('draws every section: fetches (one line per source, × pages, creators-first), keeps, goes to, when, tells', () => {
    render(<PlanCard plan={PLAN} cost={COST} onCreate={() => undefined} onChange={() => undefined} onDismiss={() => undefined} />);
    const card = screen.getByTestId('builder-plan');
    expect(card.textContent).toContain('Smart home India — Instagram digest');
    const fetch = screen.getByTestId('plan-fetch').textContent || '';
    expect(fetch).toMatch(/Instagram · search hashtag \(hashtag: smarthomeindia\) × 8 pages/);
    expect(fetch).toMatch(/Find creators with Instagram · search profiles \(query: smart home india\) — the first 20 → each one's user posts, last 30 days/);
    expect(screen.getByTestId('plan-keep').textContent).toMatch(/Keep only posts about smart home in India/);
    expect(screen.getByTestId('plan-output').textContent).toMatch(/one Google Sheet, kept adding to/);
    expect(screen.getByTestId('plan-when').textContent).toMatch(/every Monday at 08:00/);
    expect(screen.getByTestId('plan-notify').textContent).toMatch(/you on WhatsApp/);
    // never a JSON wall
    expect(card.textContent).not.toMatch(/"actionId"|\{"/);
  });

  it('marks the failing source — kept so it fills in later — from cost.unhealthy, not from the reply text', () => {
    render(<PlanCard plan={PLAN} cost={COST} onCreate={() => undefined} />);
    const marks = screen.getAllByTestId('plan-source-unhealthy');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toMatch(/Instagram · Hashtag Search is down at the vendor right now — kept so it fills in later/);
    expect(marks[0].getAttribute('title')).toBe('not_found for every call in the last 18 h');
    cleanup();
    render(<PlanCard plan={PLAN} cost={{ ...COST, unhealthy: [] }} onCreate={() => undefined} />);
    expect(screen.queryByTestId('plan-source-unhealthy')).toBeNull();
  });

  it('the cost line: ≈ credits · ≈ AI tokens ≈ ₹ per run, and "how" opens the arithmetic', () => {
    render(<PlanCard plan={PLAN} cost={COST} onCreate={() => undefined} />);
    const line = screen.getByTestId('builder-plan-cost');
    expect(line.textContent).toMatch(/≈ 28 credits · ≈ 60k AI tokens ≈ ₹18 per run/);
    expect(screen.queryByTestId('builder-plan-how')).toBeNull();
    fireEvent.click(line);
    expect(screen.getByTestId('builder-plan-how').textContent).toMatch(/8 pages × 1 credit = 8/);
    expect(screen.getByTestId('builder-plan-how').textContent).toMatch(/at ₹0.3 per 1k tokens/);
    // no shaping → no AI cost, said plainly
    expect(costLine({ credits: 5, aiTokens: 0, items: 60, how: '' })).toBe('≈ 5 credits per run · no AI cost');
    expect(costLine({ credits: 1, aiTokens: 3600, items: 12, how: '', aiRupees: 1 })).toBe('≈ 1 credit · ≈ 4k AI tokens ≈ ₹1 per run');
  });

  it('both cost figures while a source is down (BEA-1375): "≈ 28 credits (≈ 20 while Instagram · Hashtag Search is down)" from the server\'s nowCredits, one figure when they agree', () => {
    render(<PlanCard plan={PLAN} cost={{ ...COST, nowCredits: 20 }} onCreate={() => undefined} />);
    expect(screen.getByTestId('builder-plan-cost').textContent).toMatch(/≈ 28 credits \(≈ 20 while Instagram · Hashtag Search is down\) · ≈ 60k AI tokens ≈ ₹18 per run/);
    cleanup();
    // equal → no parenthesis; no unhealthy names → none either (the server only differs when a card says FAILING)
    render(<PlanCard plan={PLAN} cost={{ ...COST, nowCredits: 28 }} onCreate={() => undefined} />);
    expect(screen.getByTestId('builder-plan-cost').textContent).toMatch(/^≈ 28 credits · ≈ 60k/);
    expect(creditsText({ credits: 19, nowCredits: 11, unhealthy: [{ actionId: 'a', name: 'Search Hashtag Posts', note: '' }] })).toBe('≈ 19 credits (≈ 11 while Search Hashtag Posts is down)');
    expect(creditsText({ credits: 19, nowCredits: 11 })).toBe('≈ 19 credits'); // no name to say — the server always sends one with a differing nowCredits
    expect(creditsText({ credits: 1, nowCredits: 1, unhealthy: [] })).toBe('≈ 1 credit');
    expect(creditsText({ credits: 7 })).toBe('≈ 7 credits'); // an older API answer without nowCredits
    expect(costLine({ credits: 7, nowCredits: 2, aiTokens: 0, items: 60, how: '', unhealthy: [{ actionId: 'a', name: 'Popular Search', note: '' }] })).toBe('≈ 7 credits (≈ 2 while Popular Search is down) per run · no AI cost');
    expect(downText(['A', 'B'])).toBe('A and B are down');
  });

  it('a Watch plan, a Document output, no notify — the words change; a plan with no sources says so', () => {
    render(<PlanCard plan={{ ...PLAN, mode: 'watch', shape: undefined, output: { kind: 'document', append: false }, notify: { whatsapp: false, telegram: false }, schedule: null, sources: [] }} cost={null} onCreate={() => undefined} />);
    expect(screen.getByTestId('plan-fetch').textContent).toMatch(/nothing yet/);
    expect(screen.getByTestId('plan-keep').textContent).toMatch(/Watch — only what is new or changed since last time · rows as fetched — no AI step/);
    expect(screen.getByTestId('plan-output').textContent).toMatch(/a Document in your library/);
    expect(screen.getByTestId('plan-when').textContent).toMatch(/only when you press Run/);
    expect(screen.getByTestId('plan-notify').textContent).toMatch(/no one/);
    expect(screen.queryByTestId('builder-plan-cost')).toBeNull();
  });

  it('Create · Change something · Not now each call their handler; the two secondary buttons only exist when handed a handler', () => {
    const onCreate = vi.fn(); const onChange = vi.fn(); const onDismiss = vi.fn();
    render(<PlanCard plan={PLAN} cost={COST} onCreate={onCreate} onChange={onChange} onDismiss={onDismiss} createLabel="Create this job" />);
    fireEvent.click(screen.getByTestId('plan-create'));
    fireEvent.click(screen.getByTestId('plan-change'));
    fireEvent.click(screen.getByTestId('plan-dismiss'));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('plan-create').textContent).toContain('Create this job');
    cleanup();
    render(<PlanCard plan={PLAN} cost={COST} onCreate={onCreate} />);
    expect(screen.queryByTestId('plan-change')).toBeNull();
    expect(screen.queryByTestId('plan-dismiss')).toBeNull();
    // creating → every button is off
    cleanup();
    render(<PlanCard plan={PLAN} cost={COST} creating onCreate={onCreate} onChange={onChange} onDismiss={onDismiss} />);
    expect((screen.getByTestId('plan-create') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('plan-change') as HTMLButtonElement).disabled).toBe(true);
  });

  it('the goal is the first line — "For: <goal>" (BEA-1378) — and absent when none is established yet', () => {
    render(<PlanCard plan={PLAN} cost={COST} goal="understand how they are posting content to get the maximum reach" onCreate={() => undefined} />);
    const row = screen.getByTestId('plan-goal');
    expect(row.textContent).toContain('For');
    expect(row.textContent).toContain('understand how they are posting content to get the maximum reach');
    // it is the FIRST row of the plan's body — before Fetches
    const card = screen.getByTestId('builder-plan');
    const body = card.textContent || '';
    expect(body.indexOf('For')).toBeLessThan(body.indexOf('Fetches'));
    cleanup();
    render(<PlanCard plan={PLAN} cost={COST} onCreate={() => undefined} />);
    expect(screen.queryByTestId('plan-goal')).toBeNull();
    cleanup();
    render(<PlanCard plan={PLAN} cost={COST} goal={null} onCreate={() => undefined} />);
    expect(screen.queryByTestId('plan-goal')).toBeNull();
  });

  it('sourceLine: the argument values ride along, `_`-keys do not, a lone page count is left out', () => {
    expect(sourceLine({ kind: 'source', actionId: 'svc:instagram.search_popular', args: { query: 'home automation', _pages: 3 }, pages: 1 })).toBe('Instagram · search popular (query: home automation)');
    expect(sourceLine({ kind: 'source', actionId: 'svc:instagram.search_popular', args: { query: 'home automation' }, pages: 3 })).toBe('Instagram · search popular (query: home automation) × 3 pages');
  });
});
