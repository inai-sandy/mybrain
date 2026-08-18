import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AgentBuilder, withCreatedFlag } from './AgentBuilder';
import { readBuilderSeed, readSocialPrefill } from './Agents';
import { makeAgentUrl } from './SocialPlatform';
import { AgentApp } from './AgentApp';
import { BuilderMessage, isSampleLine } from '../ui/BuilderMessage';

/**
 * BEA-1372 — the Social → builder hand-off and the chat rows.
 *  - "Make it an agent" builds `/agent?builder=chat&tool=&args=&label=&sample=` with a compact view of the answer;
 *  - the Agents page reads it (`readBuilderSeed`) and the pre-filled form is still readable off the same URL;
 *  - AgentBuilder with a seed POSTs it, shows the builder's first line as the FIRST message, and offers
 *    "Repeat exactly this call" (the form) instead of "Prefer the quick form?";
 *  - a 🔎 sample line is its own muted row, the text as the server wrote it;
 *  - Create → `?created=1` and the agent page offers Run now once.
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../ui/DictateButton', () => ({ DictateButton: () => null }));
vi.mock('../ui/ToolPicker', () => ({ ToolPicker: () => null, useCatalog: () => ({ tools: [] }) }));

afterEach(() => cleanup());
// jsdom has no scrollIntoView; the builders call it after every message
beforeEach(() => { (Element.prototype as any).scrollIntoView = () => undefined; });

const params = (q: string) => new URLSearchParams(q);

describe('the hand-off URL', () => {
  it('makeAgentUrl → builder=chat + tool + args + label + a compact sample (count · listKey · fields · credits)', () => {
    const url = makeAgentUrl({ actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia', date_posted: 'last-month' }, label: 'Instagram · Search Hashtag Posts', data: { posts: [{ id: '1', caption: 'a', owner: { username: 'x' } }, { id: '2', caption: 'b', owner: { username: 'y' } }] }, credits: 1 });
    const p = new URL(`https://x${url}`).searchParams;
    expect(p.get('builder')).toBe('chat');
    expect(p.get('tool')).toBe('svc:instagram.search_hashtag');
    expect(JSON.parse(p.get('args')!)).toEqual({ hashtag: 'smarthomeindia', date_posted: 'last-month' });
    const sample = JSON.parse(p.get('sample')!);
    expect(sample).toMatchObject({ count: 2, listKey: 'posts', credits: 1 });
    expect(sample.fields).toContain('caption');
    // nothing found today → notFound rides along, no count
    const none = new URL(`https://x${makeAgentUrl({ actionId: 'svc:tiktok.profile', args: { handle: 'q' }, label: 'TikTok · Profile', notFound: true, credits: 0 })}`).searchParams;
    expect(JSON.parse(none.get('sample')!)).toEqual({ credits: 0, notFound: true });
  });

  it('readBuilderSeed reads it; readSocialPrefill (the form) still reads the same URL when asked for both kinds, and NOT by default', () => {
    const q = `builder=chat&tool=${encodeURIComponent('svc:instagram.search_hashtag')}&args=${encodeURIComponent(JSON.stringify({ hashtag: 'x' }))}&label=Instagram&sample=${encodeURIComponent(JSON.stringify({ count: 8, credits: 1 }))}`;
    expect(readBuilderSeed(params(q))).toEqual({ tool: 'svc:instagram.search_hashtag', args: { hashtag: 'x' }, label: 'Instagram', sample: { count: 8, credits: 1 } });
    expect(readSocialPrefill(params(q))).toBeNull(); // the form does not open by itself
    expect(readSocialPrefill(params(q), ['1', 'chat'])?.tool).toBe('svc:instagram.search_hashtag'); // …but "Repeat exactly this call" has what it needs
    expect(readBuilderSeed(params('builder=1&tool=svc:instagram.search_hashtag'))).toBeNull();
    expect(readBuilderSeed(params(`builder=chat&tool=svc:instagram.search_hashtag&sample=%7Bnot-json`))).toEqual({ tool: 'svc:instagram.search_hashtag', args: {}, label: undefined });
  });

  it('withCreatedFlag adds ?created=1 (or &created=1)', () => {
    expect(withCreatedFlag('/agent/a/ag1')).toBe('/agent/a/ag1?created=1');
    expect(withCreatedFlag('/agent/a/ag1?mode=flow')).toBe('/agent/a/ag1?mode=flow&created=1');
  });
});

describe('AgentBuilder with a seed', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); (globalThis as any).fetch = fetchMock; });

  const SEED_LINE = 'You just ran Instagram · Search Hashtag Posts (hashtag: smarthomeindia) and got 8 posts for 1 credit. Is this the kind of thing you want, and how much of it?';
  function serve(state: any) {
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      if (url === '/api/agent/builder/seed') return { ok: true, json: async () => ({ log: [{ who: 'ai', kind: 'seed', text: SEED_LINE }], spec: null, plan: null, cost: null }) };
      if (url === '/api/agent/builder' && (!init || !init.method)) return { ok: true, json: async () => state.current };
      if (url === '/api/agent/builder/chat') return { ok: true, json: async () => state.reply };
      return { ok: true, json: async () => ({}) };
    });
  }

  it('POSTs the seed once, shows the builder\'s line as the FIRST message with a "from your Social run" tag, and offers "Repeat exactly this call"', async () => {
    const state = { current: { log: [], spec: null, plan: null, cost: null }, reply: {} };
    serve(state);
    const onUseForm = vi.fn(); const onSeeded = vi.fn();
    render(<AgentBuilder seed={{ tool: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, label: 'Instagram · Search Hashtag Posts', sample: { count: 8, listKey: 'posts', credits: 1 } }} onSeeded={onSeeded} onCreated={() => undefined} onUseForm={onUseForm} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId('builder-seed-row')).toBeTruthy());
    const seedCall = fetchMock.mock.calls.find((c) => c[0] === '/api/agent/builder/seed');
    expect(seedCall).toBeTruthy();
    expect(JSON.parse(seedCall![1].body)).toEqual({ actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, label: 'Instagram · Search Hashtag Posts', sample: { count: 8, listKey: 'posts', credits: 1 } });
    expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/agent/builder/seed')).toHaveLength(1);
    expect(onSeeded).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('builder-seed-row').textContent).toContain(SEED_LINE);
    expect(screen.getByTestId('builder-seed-row').textContent).toMatch(/from your Social run/);
    // the form is one tap away, under its new name; the old line is gone
    expect(screen.queryByText(/Prefer the quick form/)).toBeNull();
    fireEvent.click(screen.getByTestId('repeat-exact-call'));
    expect(onUseForm).toHaveBeenCalledTimes(1);
  });

  it('a seed the server refuses is SAID in the chat and onSeeded is NOT called (the URL keeps the sample for a retry)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/agent/builder/seed') return { ok: false, json: async () => ({ message: 'Say which action was run.' }) };
      return { ok: true, json: async () => ({ log: [] }) };
    });
    const onSeeded = vi.fn();
    render(<AgentBuilder seed={{ tool: 'svc:instagram.search_hashtag', args: {} }} onSeeded={onSeeded} onCreated={() => undefined} onUseForm={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/Say which action was run/)).toBeTruthy());
    expect(onSeeded).not.toHaveBeenCalled();
    expect(screen.queryByTestId('builder-seed-row')).toBeNull();
  });

  it('without a seed: reads the conversation, no seed POST, the usual "Prefer the quick form?" line', async () => {
    const state = { current: { log: [{ who: 'you', text: 'hi' }, { who: 'ai', text: 'What should it do?' }], spec: null, plan: null, cost: null }, reply: {} };
    serve(state);
    render(<AgentBuilder onCreated={() => undefined} onUseForm={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('What should it do?')).toBeTruthy());
    expect(fetchMock.mock.calls.some((c) => c[0] === '/api/agent/builder/seed')).toBe(false);
    expect(screen.getByText(/Prefer the quick form/)).toBeTruthy();
  });

  it('a 🔎 sample line mid-conversation is its own muted row (text as written), never a bubble; a plan turn shows the card with Change something → focuses the input, Not now → hides it', async () => {
    const PLAN = { name: 'Hashtag digest', sources: [{ kind: 'source', id: 'svc:instagram.search_hashtag', actionId: 'svc:instagram.search_hashtag', args: { hashtag: 'smarthomeindia' }, pages: 2 }], merge: false, output: { kind: 'sheet', append: false }, notify: { whatsapp: false, telegram: false }, schedule: null, mode: 'run' };
    const SAMPLE = '🔎 I tried Instagram · Popular Search (query: home automation) — 12 posts · fields: id, caption, owner, url · no date field · 1 credit';
    const state: any = { current: { log: [], spec: null, plan: null, cost: null }, reply: { reply: 'Here is the plan.', plan: PLAN, cost: { credits: 2, aiTokens: 0, items: 24, how: 'Instagram search hashtag: 2 pages × 1 credit = 2 → ≈ 2 credits per run.' } } };
    serve(state);
    render(<AgentBuilder onCreated={() => undefined} onUseForm={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // the owner types; the server's row now carries: you · 🔎 sample · ai reply
    state.current = { log: [{ who: 'you', text: 'posts about smart home' }, { who: 'ai', kind: 'sample', text: SAMPLE }, { who: 'ai', text: 'Here is the plan.' }], spec: null, plan: PLAN, cost: state.reply.cost };
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'posts about smart home' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('builder-sample-row')).toBeTruthy());
    const row = screen.getByTestId('builder-sample-row');
    expect(row.textContent).toContain('I tried Instagram · Popular Search (query: home automation) — 12 posts · fields: id, caption, owner, url · no date field · 1 credit');
    expect(row.textContent).not.toMatch(/\{/); // never a JSON wall
    // the plan card, with the three buttons
    await waitFor(() => expect(screen.getByTestId('builder-plan')).toBeTruthy());
    expect(screen.getByTestId('builder-plan-cost').textContent).toMatch(/≈ 2 credits per run · no AI cost/);
    fireEvent.click(screen.getByTestId('plan-change'));
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
    fireEvent.click(screen.getByTestId('plan-dismiss'));
    expect(screen.queryByTestId('builder-plan')).toBeNull();
    fireEvent.click(screen.getByTestId('plan-show-again'));
    expect(screen.getByTestId('builder-plan')).toBeTruthy();
  });

  it('BuilderMessage: kind sample or a leading 🔎 → the muted row; a plain ai line → the bubble', () => {
    expect(isSampleLine({ who: 'ai', kind: 'sample', text: 'x' })).toBe(true);
    expect(isSampleLine({ who: 'ai', text: '🔎 I tried…' })).toBe(true);
    expect(isSampleLine({ who: 'ai', text: 'Here is the plan.' })).toBe(false);
    expect(isSampleLine({ who: 'you', text: '🔎 not mine' })).toBe(false);
    render(<BuilderMessage m={{ who: 'ai', text: '🔎 I tried X — 3 items · 1 credit' }} />);
    expect(screen.getByTestId('builder-sample-row').textContent).toBe('I tried X — 3 items · 1 credit');
  });
});

describe('the agent page after Create (?created=1)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); (globalThis as any).fetch = fetchMock; });
  it('offers Run now once; Later drops the flag; Run now starts the run', async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: any) => {
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url === '/api/agent/agents/ag1') return { ok: true, json: async () => ({ id: 'ag1', name: 'BEA-1372 test', ui: { headline: 'Run it', inputs: [], view: 'report', runLabel: 'Run →' }, tools: [], toolArgs: {}, enabled: true }) };
      if (url.startsWith('/api/agent/runs')) return { ok: true, json: async () => [] };
      if (url.startsWith('/api/flows')) return { ok: true, json: async () => ({ flows: [] }) };
      if (url === '/api/skills') return { ok: true, json: async () => ({ skills: [] }) };
      if (url === '/api/agent/agents/ag1/run') return { ok: true, json: async () => ({ id: 'run1' }) };
      return { ok: true, json: async () => ({}) };
    });
    render(<MemoryRouter initialEntries={['/agent/a/ag1?created=1']}><Routes><Route path="/agent/a/:id" element={<AgentApp />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('created-banner')).toBeTruthy());
    fireEvent.click(screen.getByTestId('created-run-now'));
    await waitFor(() => expect(calls).toContain('POST /api/agent/agents/ag1/run'));
    expect(screen.queryByTestId('created-banner')).toBeNull();
    cleanup();
    render(<MemoryRouter initialEntries={['/agent/a/ag1']}><Routes><Route path="/agent/a/:id" element={<AgentApp />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('BEA-1372 test')).toBeTruthy());
    expect(screen.queryByTestId('created-banner')).toBeNull();
  });
});
