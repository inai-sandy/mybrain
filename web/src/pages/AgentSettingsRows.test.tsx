import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { AgentApp, advancedSummary, goalOf, resultSummary, scheduleSummary, sourcesSummary, toolsSummary, watchSummary, whatSummary } from './AgentApp';

/**
 * BEA-1381 — the Settings sheet is an accordion of summary rows (approved mockup at
 * specs/mockups/agent-settings.html):
 *  - eight rows in the mocked order, ONE open at a time, "What it does" open first;
 *  - every closed row's summary line states the CURRENT values (live, not placeholders);
 *  - engine (non-social) agents get no Sources row and no Watch row;
 *  - drafted fields (task/rubric, source args, watch mode) surface a sticky "Save changes"
 *    bar when dirty, and its one PATCH carries exactly what the old per-section Saves sent.
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../ui/DictateButton', () => ({ DictateButton: () => null }));
vi.mock('./AgentJobPanels', () => ({ FlowPanel: () => <div data-testid="flow-panel" />, EvalsPanel: () => null, RunsPanel: () => null }));
vi.mock('../ui/ToolPicker', () => ({ ToolPicker: () => null, useCatalog: () => ({ tools: [] }) }));

const SOCIAL_AGENT = {
  id: 'ag1', name: 'Smart Home digest', areaId: null,
  description: 'For: understand what gets reach — Weekly digest',
  prompt: 'Merge all sources and de-duplicate on shortcode.', rubric: 'Every row is a real post.',
  tools: ['svc:instagram.search_popular'],
  toolArgs: {
    'svc:instagram.search_popular': { actionId: 'svc:instagram.search_popular', args: { query: 'smarthomeindia' }, _pages: 2 },
    'svc:instagram.search_popular#2': { actionId: 'svc:instagram.search_popular', args: { query: 'homeautomation' } },
  },
  ui: { headline: 'Run', inputs: [], view: 'report', runLabel: 'Run' }, enabled: true,
  outputDest: 'sheet', sheetId: null, sheetAppend: false, notifyWhatsApp: true,
  schedule: { every: 'week', dow: 1, at: '08:00' }, scheduleText: 'Every Monday at 08:00',
  mode: 'run', alertCondition: null, threshold: null, skills: ['sk1'], engine: null, keepDays: null,
};
const ENGINE_AGENT = { ...SOCIAL_AGENT, id: 'ag2', tools: [], toolArgs: null, outputDest: 'document', notifyWhatsApp: false, engine: { provider: 'codex', model: 'gpt-5.2' }, keepDays: 30, skills: [] };

function mockApi(agent: any, extra: (url: string, init?: any) => any = () => null) {
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    const x = extra(url, init);
    if (x) return x;
    if (url === `/api/agent/agents/${agent.id}` && init?.method === 'PATCH') { const body = JSON.parse(init.body); return { ok: true, json: async () => ({ ...agent, ...body }) }; }
    if (url === `/api/agent/agents/${agent.id}`) return { ok: true, json: async () => agent };
    if (url === `/api/social/plan/${agent.id}`) return { ok: true, json: async () => ({ plan: {}, cost: { credits: 3, aiTokens: 6000, aiRupees: 2, items: 24, how: '2 sources' } }) };
    if (url.startsWith('/api/agent/runs')) return { ok: true, json: async () => [] };
    if (url.startsWith('/api/flows')) return { ok: true, json: async () => ({ flows: [] }) };
    if (url === '/api/skills') return { ok: true, json: async () => ({ skills: [{ id: 'sk1', title: 'Summarise' }] }) };
    if (url.startsWith('/api/tools/knowledge/')) return { ok: false, json: async () => ({}) };
    return { ok: false, json: async () => ({}) };
  });
  (globalThis as any).fetch = fetchMock;
  return fetchMock;
}

function mount(agent: any, extra?: (url: string, init?: any) => any) {
  const fetchMock = mockApi(agent, extra);
  render(<MemoryRouter initialEntries={[`/agent/a/${agent.id}?tab=settings`]}><Routes><Route path="/agent/a/:id" element={<AgentApp />} /></Routes></MemoryRouter>);
  return fetchMock;
}

const rowOpen = (k: string) => (screen.getByTestId(`srow-${k}`) as HTMLDetailsElement).hasAttribute('open');

describe('summary lines say the current values (BEA-1381)', () => {
  it('goalOf reads the BEA-1378 "For: …" prefix off the description', () => {
    expect(goalOf('For: understand what gets reach — Weekly digest')).toBe('understand what gets reach');
    expect(goalOf('For: sell more')).toBe('sell more');
    expect(goalOf('Weekly digest')).toBe('');
    expect(goalOf(null)).toBe('');
  });
  it('whatSummary: goal + graded; falls back to the task when there is no goal', () => {
    expect(whatSummary(SOCIAL_AGENT)).toBe('For: understand what gets reach · graded each run');
    expect(whatSummary({ description: '', prompt: 'Fetch the posts.', rubric: '' })).toBe('Fetch the posts.');
  });
  it('sourcesSummary: count + the server cost when known', () => {
    expect(sourcesSummary(2, { credits: 3, aiTokens: 6000, aiRupees: 2, items: 24, how: '' } as any)).toBe('2 sources · ≈ 3 credits + ₹2 AI per run');
    expect(sourcesSummary(1, null)).toBe('1 source');
  });
  it('resultSummary: destination + WhatsApp state', () => {
    expect(resultSummary(SOCIAL_AGENT)).toBe('New Google Sheet each run · WhatsApp on');
    expect(resultSummary({ ...SOCIAL_AGENT, sheetAppend: true })).toBe('One Google Sheet, kept adding to · WhatsApp on');
    expect(resultSummary({ ...SOCIAL_AGENT, sheetId: 'S1' })).toBe('Appends to your Google Sheet · WhatsApp on');
    expect(resultSummary(ENGINE_AGENT)).toBe('Saved to Documents · WhatsApp off');
  });
  it('scheduleSummary: the schedule text, or the honest manual line', () => {
    expect(scheduleSummary(SOCIAL_AGENT)).toBe('Every Monday at 08:00');
    expect(scheduleSummary({ schedule: null })).toBe('Only when you press Run');
  });
  it('watchSummary: run / watch-with-baseline / alert-with-condition', () => {
    expect(watchSummary({ mode: 'run' }, null)).toBe('Fetch every time (not watching)');
    expect(watchSummary({ mode: 'watch' }, [{ lastAt: '2026-08-18T10:00:00Z' }])).toMatch(/^Watching for changes — baseline (18 Aug|Aug 18)/); // locale decides the order
    expect(watchSummary({ mode: 'watch' }, [])).toBe('Watching for changes — no baseline yet');
    expect(watchSummary({ mode: 'alert', alertCondition: 'a post mentions a price' }, [])).toBe('Alert when a post mentions a price — no baseline yet');
    expect(watchSummary({ mode: 'alert', threshold: { field: 'followers', dir: 'above', value: 10000 } }, [])).toBe('Alert when followers goes above 10000 — no baseline yet');
  });
  it('toolsSummary and advancedSummary', () => {
    expect(toolsSummary(SOCIAL_AGENT)).toBe('Toolbox: 1 picked · 1 skill');
    expect(toolsSummary(ENGINE_AGENT)).toBe("Toolbox: the agent's · no skills");
    expect(advancedSummary(SOCIAL_AGENT)).toBe('Model: default · history kept forever');
    expect(advancedSummary(ENGINE_AGENT)).toBe('Model: gpt-5.2 · history 30 days');
  });
});

describe('the accordion (BEA-1381)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => cleanup());

  it('a direct-fetch job shows all eight rows in the mocked order, "What it does" open, live summaries on the rest', async () => {
    mount(SOCIAL_AGENT);
    // The Watch row appears with the job's own answer, one render after the first row — so the
    // whole list is waited for, not just the first of it (this raced under load and failed the
    // ship gate twice; nothing about the page changed).
    await waitFor(() => {
      const ids = Array.from(document.querySelectorAll('[data-testid^="srow-"]:not([data-testid$="-summary"])')).map((el) => el.getAttribute('data-testid'));
      expect(ids).toEqual(['srow-what', 'srow-sources', 'srow-result', 'srow-schedule', 'srow-watch', 'srow-tools', 'srow-advanced', 'srow-delete']);
    });
    expect(rowOpen('what')).toBe(true);
    for (const k of ['sources', 'result', 'schedule', 'watch', 'tools', 'advanced', 'delete']) expect(rowOpen(k)).toBe(false);
    // live summaries, not placeholders
    expect(screen.getByTestId('srow-what-summary')).toHaveTextContent('For: understand what gets reach · graded each run');
    await waitFor(() => expect(screen.getByTestId('srow-sources-summary')).toHaveTextContent('2 sources · ≈ 3 credits + ₹2 AI per run'));
    expect(screen.getByTestId('srow-result-summary')).toHaveTextContent('New Google Sheet each run · WhatsApp on');
    expect(screen.getByTestId('srow-schedule-summary')).toHaveTextContent('Every Monday at 08:00');
    expect(screen.getByTestId('srow-watch-summary')).toHaveTextContent('Fetch every time (not watching)');
    expect(screen.getByTestId('srow-tools-summary')).toHaveTextContent('Toolbox: 1 picked · 1 skill');
    expect(screen.getByTestId('srow-advanced-summary')).toHaveTextContent('Model: default · history kept forever');
    // the goal is shown inside the open row too
    expect(screen.getByTestId('goal-line')).toHaveTextContent('understand what gets reach');
  });

  it('one row open at a time: opening Schedule closes What-it-does; tapping it again closes it', async () => {
    mount(SOCIAL_AGENT);
    await waitFor(() => expect(screen.getByTestId('srow-schedule')).toBeTruthy());
    fireEvent.click(screen.getByTestId('srow-schedule-summary').closest('summary')!);
    expect(rowOpen('schedule')).toBe(true);
    expect(rowOpen('what')).toBe(false);
    fireEvent.click(screen.getByTestId('srow-schedule-summary').closest('summary')!);
    expect(rowOpen('schedule')).toBe(false);
  });

  it('an engine job has NO Sources row and NO Watch row — no empty shells', async () => {
    mount(ENGINE_AGENT);
    await waitFor(() => expect(screen.getByTestId('srow-what')).toBeTruthy());
    expect(screen.queryByTestId('srow-sources')).toBeNull();
    expect(screen.queryByTestId('srow-watch')).toBeNull();
    expect(screen.getByTestId('srow-result')).toBeTruthy();
    expect(screen.getByTestId('srow-delete')).toBeTruthy();
  });

  it('the sticky Save appears when the task is edited and its one PATCH carries prompt+rubric, then it goes away', async () => {
    const fetchMock = mount(SOCIAL_AGENT);
    await waitFor(() => expect(screen.getByTestId('srow-what')).toBeTruthy());
    expect(screen.queryByTestId('settings-save-bar')).toBeNull(); // nothing dirty yet
    const task = document.querySelector('textarea')! as HTMLTextAreaElement;
    fireEvent.change(task, { target: { value: 'Merge and keep only India-relevant posts.' } });
    expect(screen.getByTestId('settings-save-bar')).toBeTruthy();
    // the closed-row summary keeps the SAVED goal and flags the unsaved edit honestly
    expect(screen.getByTestId('srow-what-summary')).toHaveTextContent('For: understand what gets reach · graded each run · unsaved changes');
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(screen.queryByTestId('settings-save-bar')).toBeNull());
    const patchCall = fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/agent/agents/ag1' && c[1]?.method === 'PATCH');
    expect(patchCall).toBeTruthy();
    expect(JSON.parse(patchCall![1].body)).toEqual({ prompt: 'Merge and keep only India-relevant posts.', rubric: 'Every row is a real post.' });
  });

  it("editing a source's args marks it dirty and Save changes PATCHes toolArgs (the old Sources-Save body)", async () => {
    const fetchMock = mount(SOCIAL_AGENT);
    await waitFor(() => expect(screen.getAllByTestId('tool-args').length).toBe(2));
    fireEvent.change(screen.getAllByLabelText('query')[0], { target: { value: 'smartlighting' } });
    expect(screen.getByTestId('settings-save-bar')).toBeTruthy();
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(screen.queryByTestId('settings-save-bar')).toBeNull());
    const patchCall = fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/agent/agents/ag1' && c[1]?.method === 'PATCH');
    const body = JSON.parse(patchCall![1].body);
    expect(Object.keys(body)).toEqual(['toolArgs']);
    expect(body.toolArgs['svc:instagram.search_popular']).toEqual({ actionId: 'svc:instagram.search_popular', args: { query: 'smartlighting' }, _pages: 2 });
  });

  it('changing the watch mode marks it dirty and Save changes PATCHes mode/alertCondition/threshold (the old Watch-Save body)', async () => {
    const fetchMock = mount(SOCIAL_AGENT);
    await waitFor(() => expect(screen.getByTestId('job-mode')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Each run'), { target: { value: 'watch' } });
    // the closed row's summary keeps saying what is SAVED, plus an honest unsaved marker
    expect(screen.getByTestId('srow-watch-summary')).toHaveTextContent('Fetch every time (not watching) · unsaved changes');
    expect(screen.getByTestId('settings-save-bar')).toBeTruthy();
    fireEvent.click(screen.getByText('Save changes'));
    await waitFor(() => expect(screen.queryByTestId('settings-save-bar')).toBeNull());
    const patchCall = fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/agent/agents/ag1' && c[1]?.method === 'PATCH');
    expect(JSON.parse(patchCall![1].body)).toEqual({ mode: 'watch', alertCondition: null, threshold: null });
    // once saved, the summary states the new mode with no marker
    await waitFor(() => expect(screen.getByTestId('srow-watch-summary')).toHaveTextContent('Watching for changes'));
    expect(screen.getByTestId('srow-watch-summary').textContent).not.toContain('unsaved');
  });

  it('immediate-save controls still save the moment they change (WhatsApp toggle → its own PATCH, no save bar)', async () => {
    const fetchMock = mount(SOCIAL_AGENT);
    await waitFor(() => expect(screen.getByTestId('srow-result')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: /Send to WhatsApp/i, hidden: true }));
    await waitFor(() => expect(fetchMock.mock.calls.some((c: any[]) => c[0] === '/api/agent/agents/ag1' && c[1]?.method === 'PATCH')).toBe(true));
    const patchCall = fetchMock.mock.calls.find((c: any[]) => c[0] === '/api/agent/agents/ag1' && c[1]?.method === 'PATCH');
    expect(JSON.parse(patchCall![1].body)).toEqual({ notifyWhatsApp: false });
    expect(screen.queryByTestId('settings-save-bar')).toBeNull();
  });
});
