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
    // keyed by source id, `_pages` beside the entry's args (BEA-1374)
    expect(body.toolArgs).toEqual({ 'svc:instagram.search_popular': { actionId: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, _pages: 5 } });
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
    // tools = every action the sources call (the finder AND the per-creator action), once each
    expect(body.tools).toEqual(['svc:instagram.search_popular', 'svc:instagram.search_profiles', 'svc:instagram.user_posts']);
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

/**
 * BEA-1374 — sources keyed by source id on the job's Settings: five sources on ONE action each get
 * their own editor (args + pages); Remove works per source; adding the same action again makes a
 * new source with its own id; the save carries the new shape and `tools` = the actions once each.
 */
describe('several sources on one action — job Settings (BEA-1374)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => cleanup());

  const HASHTAGS = ['smarthomeindia', 'homeautomationindia', 'smarthome', 'homeautomation', 'smartlighting'];
  const toolArgs: Record<string, any> = {};
  HASHTAGS.forEach((h, i) => { toolArgs[i ? `svc:instagram.search_popular#${i + 1}` : 'svc:instagram.search_popular'] = { actionId: 'svc:instagram.search_popular', args: { query: h }, _pages: 3 }; });
  const agent = { id: 'ag5', name: 'Five', description: '', tools: ['svc:instagram.search_popular'], toolArgs, ui: { headline: 'Run', inputs: [], view: 'report', runLabel: 'Run' }, enabled: true, prompt: 'Keep every result as fetched.', outputDest: 'sheet', sheetId: null, sheetAppend: true, mode: 'run' };

  function mount() {
    const patches: any[] = [];
    mockApi((url, init) => {
      if (url === '/api/agent/agents/ag5' && init?.method === 'PATCH') { const body = JSON.parse(init.body); patches.push(body); return { ok: true, json: async () => ({ ...agent, ...body }) }; }
      if (url === '/api/agent/agents/ag5') return { ok: true, json: async () => agent };
      if (url === '/api/social/plan/ag5') return { ok: true, json: async () => ({ plan: {}, cost: { credits: 15, aiTokens: 0, how: '5 × 3 pages' } }) };
      if (url.startsWith('/api/agent/runs')) return { ok: true, json: async () => [] };
      if (url.startsWith('/api/flows')) return { ok: true, json: async () => ({ flows: [] }) };
      if (url === '/api/skills') return { ok: true, json: async () => ({ skills: [] }) };
      return null;
    });
    render(<MemoryRouter initialEntries={['/agent/agents/ag5?tab=settings']}><Routes><Route path="/agent/agents/:id" element={<AgentApp />} /></Routes></MemoryRouter>);
    return patches;
  }

  it('draws one editor per source with its own query + pages, Remove drops just that one (tools keep the action), and "keep adding" is on', async () => {
    const patches = mount();
    await waitFor(() => expect(screen.getAllByTestId('tool-args')).toHaveLength(5));
    const editors = screen.getAllByTestId('tool-args');
    expect((within(editors[1]).getByLabelText('query') as HTMLInputElement).value).toBe('homeautomationindia');
    expect((within(editors[1]).getByLabelText('pages') as HTMLInputElement).value).toBe('3');
    expect(screen.getAllByLabelText(/Remove source/)).toHaveLength(5);
    expect((screen.getByLabelText('Keep adding to one sheet') as HTMLInputElement).checked).toBe(true);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getAllByLabelText(/Remove source/)[2]); // the third source (#3, "smarthome")
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].tools).toEqual(['svc:instagram.search_popular']);
    expect(Object.keys(patches[0].toolArgs)).toEqual(['svc:instagram.search_popular', 'svc:instagram.search_popular#2', 'svc:instagram.search_popular#4', 'svc:instagram.search_popular#5']);
    expect(patches[0].toolArgs['svc:instagram.search_popular#4']).toEqual({ actionId: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, _pages: 3 });
  });

  it('the builder form: "Keep adding to one sheet" → sheetAppend:true on the POST (and it hides once a sheet link is pasted)', async () => {
    const fetchMock = mockApi((url, init) => (url === '/api/agent/agents' && init?.method === 'POST' ? { ok: true, json: async () => ({ id: 'ag-k' }) } : null));
    const onCreated = vi.fn();
    render(<MemoryRouter><NewAgentForm social={{ tool: 'svc:instagram.search_popular', args: { query: 'homeautomation' }, label: 'Instagram · Popular Search' }} onCreated={onCreated} onCancel={() => undefined} /></MemoryRouter>);
    fireEvent.click(screen.getByLabelText('Keep adding to one sheet'));
    fireEvent.change(screen.getByLabelText('Append to sheet'), { target: { value: 'S1' } });
    expect(screen.queryByLabelText('Keep adding to one sheet')).toBeNull(); // a named sheet already appends
    fireEvent.change(screen.getByLabelText('Append to sheet'), { target: { value: '' } });
    expect((screen.getByLabelText('Keep adding to one sheet') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('ag-k'));
    const body = JSON.parse(fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/agent/agents')![1].body);
    expect(body).toMatchObject({ outputDest: 'sheet', sheetId: null, sheetAppend: true });
  });

  it('Add another source with the SAME action → a sixth source with its own id (#6); the picker does not grey it out', async () => {
    const patches = mount();
    await waitFor(() => expect(screen.getAllByTestId('tool-args')).toHaveLength(5));
    fireEvent.click(screen.getByText('+ Add another source'));
    await waitFor(() => expect(screen.getByLabelText('Endpoint')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'svc:instagram.search_popular' } });
    const panel = within(screen.getByTestId('add-source'));
    expect(screen.getByTestId('same-action-note')).toBeTruthy();
    fireEvent.change(panel.getByLabelText('query'), { target: { value: 'smart switches india' } });
    const add = panel.getByText('Add source').closest('button') as HTMLButtonElement;
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0].tools).toEqual(['svc:instagram.search_popular']);
    expect(patches[0].toolArgs['svc:instagram.search_popular#6']).toEqual({ actionId: 'svc:instagram.search_popular', args: { query: 'smart switches india' } });
    expect(Object.keys(patches[0].toolArgs)).toHaveLength(6);
  });
});
