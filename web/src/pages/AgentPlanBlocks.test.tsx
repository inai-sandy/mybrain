import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { NewAgentForm } from './Agents';
import { AgentApp } from './AgentApp';
import { ToolArgsEditor, clampPages, creatorFieldFor, creatorParamOf, creatorsCostHint, isCreatorsArgs, pagesCostHint } from '../ui/agentJobFields';

/**
 * BEA-1369 — planning blocks on the Social builder form, the job's Settings and the job page:
 *  - a "pages" field beside each source (1..11) → `toolArgs[id]._pages`, with a cost hint (pages × credits);
 *  - "Creators first" on Add another source → `{kind:'creators', find, then}` under the finder's id,
 *    drawn by its own editor (finder args, N, per-creator action, argument ← field, days);
 *  - the job page says "≈ N credits per run" from `GET /api/social/plan/:id`.
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../ui/DictateButton', () => ({ DictateButton: () => null }));
vi.mock('./AgentJobPanels', () => ({ FlowPanel: () => <div data-testid="flow-panel" />, EvalsPanel: () => null, RunsPanel: () => null }));
vi.mock('../ui/ToolPicker', () => ({ ToolPicker: () => null, useCatalog: () => ({ tools: [] }) }));

const OVERVIEW = { platforms: [{ slug: 'instagram', name: 'Instagram', actionCount: 3, tags: ['Instagram'], kinds: [], connected: true }] };
const IG = { platform: OVERVIEW.platforms[0], actions: [
  { id: 'svc:instagram.search_popular', name: 'Popular Search', description: '', service: 'instagram', tags: ['Instagram'], schema: { type: 'object', properties: { query: { type: 'string' }, cursor: { type: 'string' } }, required: ['query'] } },
  { id: 'svc:instagram.search_profiles', name: 'Search Instagram Profiles', description: '', service: 'instagram', tags: ['Instagram'], schema: { type: 'object', properties: { query: { type: 'string' }, cursor: { type: 'string' } }, required: ['query'] } },
  { id: 'svc:instagram.user_posts', name: 'Posts', description: '', service: 'instagram', tags: ['Instagram'], schema: { type: 'object', properties: { handle: { type: 'string' }, next_max_id: { type: 'string' }, trim: { type: 'boolean' } }, required: ['handle'] } },
] };
const CARDS: Record<string, any> = {
  'svc:instagram.search_popular': { actionId: 'svc:instagram.search_popular', paging: { how: 'cursor', field: 'cursor', pageSize: 12 }, cost: { credits: { typical: 1 } } },
  'svc:instagram.profile': { actionId: 'svc:instagram.profile', paging: { how: 'none' }, cost: {} },
  'svc:instagram.user_posts': { actionId: 'svc:instagram.user_posts', paging: { how: 'cursor', field: 'next_max_id' }, cost: {}, hasDateField: true },
};

function mockApi(extra: (url: string, init?: any) => any = () => null) {
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    const x = extra(url, init);
    if (x) return x;
    if (url === '/api/social') return { ok: true, json: async () => OVERVIEW };
    if (url === '/api/social/platforms/instagram') return { ok: true, json: async () => IG };
    if (url.startsWith('/api/tools/knowledge/')) { const id = decodeURIComponent(url.slice('/api/tools/knowledge/'.length)); return CARDS[id] ? { ok: true, json: async () => CARDS[id] } : { ok: false, json: async () => ({}) }; }
    return { ok: false, json: async () => ({}) };
  });
  (globalThis as any).fetch = fetchMock;
  return fetchMock;
}

describe('pages per source (BEA-1369)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => cleanup());

  it('helpers: clampPages 1..11; cost hints say the arithmetic and when a default is used', () => {
    expect([clampPages(''), clampPages('5'), clampPages(40), clampPages(0)]).toEqual([1, 5, 11, 1]);
    expect(pagesCostHint(1, { n: 1, known: true })).toBe('≈ 1 credit per run');
    expect(pagesCostHint(5, { n: 1, known: true })).toBe('≈ 5 credits per run (5 pages × 1)');
    expect(pagesCostHint(3, { n: 1, known: false })).toMatch(/≈ 3 credits per run \(3 pages × 1\) — about 1 a page until/);
    expect(creatorsCostHint(5, { n: 1, known: true }, { n: 1, known: true })).toBe('≈ 6 credits per run (1 finder call + 5 × 1)');
    expect(isCreatorsArgs({ kind: 'creators', find: {}, then: {} })).toBe(true);
    expect(isCreatorsArgs({ query: 'x', _pages: 3 })).toBe(false);
    expect(creatorParamOf({ properties: { handle: {}, next_max_id: {} } })).toBe('handle');
    expect(creatorParamOf({ properties: { user_id: {} } })).toBe('user_id');
    expect(creatorFieldFor('handle')).toBe('username');
    expect(creatorFieldFor('user_id')).toBe('id');
  });

  it('the editor shows a pages field (1–11) when the action pages, hides _pages from the argument list, and writes _pages only when > 1', async () => {
    mockApi();
    const onChange = vi.fn();
    render(<MemoryRouter><ToolArgsEditor tool="svc:instagram.search_popular" args={{ query: 'homeautomation', _pages: 5 }} onChange={onChange} toolName="Instagram · Popular Search" /></MemoryRouter>);
    expect(screen.getByLabelText('query')).toBeTruthy();
    expect(screen.queryByLabelText('_pages')).toBeNull();
    const pages = screen.getByLabelText('pages') as HTMLInputElement;
    expect(pages.value).toBe('5');
    expect(pages.max).toBe('11');
    // the cost hint uses the card's per-call cost once loaded
    await waitFor(() => expect(screen.getByTestId('tool-args')).toHaveTextContent('≈ 5 credits per run (5 pages × 1)'));
    fireEvent.change(pages, { target: { value: '8' } });
    expect(onChange).toHaveBeenLastCalledWith({ query: 'homeautomation', _pages: 8 });
    fireEvent.change(pages, { target: { value: '1' } });
    expect(onChange).toHaveBeenLastCalledWith({ query: 'homeautomation' }); // 1 = the default, not stored
    fireEvent.change(pages, { target: { value: '99' } });
    expect(onChange).toHaveBeenLastCalledWith({ query: 'homeautomation', _pages: 11 });
  });

  it('an action that does not page (the card says none) has no pages field', async () => {
    mockApi();
    render(<MemoryRouter><ToolArgsEditor tool="svc:instagram.profile" args={{ handle: 'legrand_in' }} onChange={() => undefined} /></MemoryRouter>);
    expect(screen.getByLabelText('pages')).toBeTruthy(); // until the card answers
    await waitFor(() => expect(screen.queryByLabelText('pages')).toBeNull());
  });

  it('the builder form POSTs _pages inside toolArgs', async () => {
    const fetchMock = mockApi((url, init) => (url === '/api/agent/agents' && init?.method === 'POST' ? { ok: true, json: async () => ({ id: 'ag-p' }) } : null));
    const onCreated = vi.fn();
    render(<MemoryRouter><NewAgentForm social={{ tool: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, label: 'Instagram · Popular Search' }} onCreated={onCreated} onCancel={() => undefined} /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('pages'), { target: { value: '5' } });
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('ag-p'));
    const body = JSON.parse(fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/agent/agents')![1].body);
    expect(body.toolArgs).toEqual({ 'svc:instagram.search_popular': { query: 'homeautomation', _pages: 5 } });
  });
});

describe('creators-first (BEA-1369)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => cleanup());

  it('Add another source → Creators first: finder + per-creator + N + days → the block under the finder id, drawn by its own editor, POSTed as data', async () => {
    const fetchMock = mockApi((url, init) => (url === '/api/agent/agents' && init?.method === 'POST' ? { ok: true, json: async () => ({ id: 'ag-c' }) } : null));
    const onCreated = vi.fn();
    render(<MemoryRouter><NewAgentForm social={{ tool: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, label: 'Instagram · Popular Search' }} onCreated={onCreated} onCancel={() => undefined} /></MemoryRouter>);
    fireEvent.click(screen.getByText('Add another source'));
    await waitFor(() => expect(screen.getByLabelText('Endpoint')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Creators first'));
    // the endpoint becomes the finder; the creators fields appear
    expect(screen.getByLabelText('Find creators with')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Find creators with'), { target: { value: 'svc:instagram.search_profiles' } });
    const panel = within(screen.getByTestId('add-source'));
    fireEvent.change(panel.getByLabelText('query'), { target: { value: 'smart home india' } });
    const add = panel.getByText('Add source').closest('button') as HTMLButtonElement;
    expect(add.disabled).toBe(true); // the per-creator action is still to pick
    fireEvent.change(panel.getByLabelText('then, for each creator'), { target: { value: 'svc:instagram.user_posts' } });
    expect(panel.getByTestId('creators-fields')).toHaveTextContent('handle ← each creator\'s username');
    fireEvent.change(panel.getByLabelText('how many creators'), { target: { value: '5' } });
    fireEvent.change(panel.getByLabelText('keep the last days'), { target: { value: '30' } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    // its own editor
    await waitFor(() => expect(screen.getByTestId('creators-source')).toBeTruthy());
    const ed = within(screen.getByTestId('creators-source'));
    expect((ed.getByLabelText('find query') as HTMLInputElement).value).toBe('smart home india');
    expect((ed.getByLabelText('how many creators') as HTMLInputElement).value).toBe('5');
    await waitFor(() => expect((ed.getByLabelText('then, for each creator') as HTMLSelectElement).value).toBe('svc:instagram.user_posts'));
    expect((ed.getByLabelText('creator field') as HTMLInputElement).value).toBe('username');
    expect((ed.getByLabelText('keep the last days') as HTMLInputElement).value).toBe('30');
    await waitFor(() => expect(screen.getByTestId('creators-source')).toHaveTextContent('≈ 6 credits per run (1 finder call + 5 × 1)'));
    // edits land in the block
    fireEvent.change(ed.getByLabelText('how many creators'), { target: { value: '7' } });
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('ag-c'));
    const body = JSON.parse(fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/agent/agents')![1].body);
    expect(body.tools).toEqual(['svc:instagram.search_popular', 'svc:instagram.search_profiles']);
    expect(body.toolArgs['svc:instagram.search_profiles']).toEqual({ kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 7 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, keepDays: 30 } });
  });
});

describe('the job page says what a run costs (BEA-1369)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => cleanup());

  it('shows "≈ N credits per run" from /api/social/plan/:id for a direct-fetch job, with the arithmetic as its title', async () => {
    const agent = { id: 'ag1', name: 'Popular digest', description: 'weekly', tools: ['svc:instagram.search_popular'], toolArgs: { 'svc:instagram.search_popular': { query: 'homeautomation', _pages: 5 } }, ui: { headline: 'Run', inputs: [], view: 'report', runLabel: 'Run' }, enabled: true, prompt: 'Keep every result as fetched.', outputDest: 'sheet' };
    mockApi((url) => {
      if (url === '/api/agent/agents/ag1') return { ok: true, json: async () => agent };
      if (url === '/api/social/plan/ag1') return { ok: true, json: async () => ({ plan: {}, cost: { credits: 5, aiTokens: 0, how: 'Instagram search popular: 5 pages × 1 credit = 5 → ≈ 5 credits per run.' } }) };
      if (url.startsWith('/api/agent/runs')) return { ok: true, json: async () => [] };
      if (url.startsWith('/api/flows')) return { ok: true, json: async () => ({ flows: [] }) };
      if (url === '/api/skills') return { ok: true, json: async () => ({ skills: [] }) };
      return null;
    });
    render(<MemoryRouter initialEntries={['/agent/agents/ag1']}><Routes><Route path="/agent/agents/:id" element={<AgentApp />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('plan-cost')).toBeTruthy());
    expect(screen.getByTestId('plan-cost')).toHaveTextContent('≈ 5 credits per run');
    expect(screen.getByTestId('plan-cost').getAttribute('title')).toContain('5 pages × 1 credit');
  });
});
