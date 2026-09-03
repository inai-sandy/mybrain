import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentApp, offLine, scheduleSavedToast } from './AgentApp';

/**
 * THE ON/OFF SWITCH ON THE AGENT PAGE (BEA-1603).
 *
 * His Daily Email Agent was off and the page still said "Every day at 23:00 · next: today 23:00" —
 * there was no switch anywhere, and the schedule line never looked at `enabled`. Now the header
 * carries the switch next to the name, an off agent says "Off — it will not run on its own. Would
 * run …", and an on agent's line reads exactly as it did before.
 */
const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock('../ui/Toast', () => ({ useToast: () => toastSpy }));
vi.mock('../ui/DictateButton', () => ({ DictateButton: () => null }));
vi.mock('./AgentJobPanels', () => ({ FlowPanel: () => <div data-testid="flow-panel" />, EvalsPanel: () => null, RunsPanel: () => null }));
vi.mock('../ui/ToolPicker', () => ({ ToolPicker: () => null, useCatalog: () => ({ tools: [] }) }));

const OFF_AGENT = {
  id: 'ec3', name: 'Daily Email Agent', areaId: 'ar1', origin: 'goal',
  description: 'Read his Gmail every night and reply to what needs him.',
  prompt: 'Read his Gmail.', rubric: '', tools: [], toolArgs: null, ui: null,
  enabled: false, pausedReason: null,
  outputDest: 'document', sheetId: null, sheetAppend: false, notifyWhatsApp: false,
  schedule: { every: 'day', at: '23:00' }, scheduleText: 'Every day at 23:00',
  mode: 'run', alertCondition: null, threshold: null, skills: [], engine: null, keepDays: null,
};
const ON_AGENT = { ...OFF_AGENT, id: 'on1', enabled: true };

function mockApi(agent: any, runs: any[] = []) {
  const state = { ...agent };
  const fetchMock = vi.fn(async (url: string, init?: any) => {
    if (url === `/api/agent/agents/${agent.id}` && init?.method === 'PATCH') {
      const body = JSON.parse(init.body);
      Object.assign(state, body);
      // The server's rule (BEA-1603): a schedule saved on an off agent with no pausedReason means ON.
      if (body.schedule && !state.pausedReason && body.enabled === undefined) state.enabled = true;
      return { ok: true, json: async () => ({ ...state }) };
    }
    if (url === `/api/agent/agents/${agent.id}`) return { ok: true, json: async () => ({ ...state }) };
    if (url === '/api/agent/settings') return { ok: true, json: async () => ({ timezone: 'Asia/Kolkata' }) };
    if (url.startsWith('/api/agent/runs')) return { ok: true, json: async () => runs };
    if (url.startsWith('/api/flows')) return { ok: true, json: async () => ({ flows: [] }) };
    if (url === '/api/skills') return { ok: true, json: async () => ({ skills: [] }) };
    return { ok: false, json: async () => ({}) };
  });
  (globalThis as any).fetch = fetchMock;
  return fetchMock;
}

function mount(agent: any, search = '', runs: any[] = []) {
  const fetchMock = mockApi(agent, runs);
  render(<MemoryRouter initialEntries={[`/agent/a/${agent.id}${search}`]}><Routes><Route path="/agent/a/:id" element={<AgentApp />} /></Routes></MemoryRouter>);
  return fetchMock;
}

const patchCalls = (fetchMock: any, id: string) => fetchMock.mock.calls.filter((c: any[]) => c[0] === `/api/agent/agents/${id}` && c[1]?.method === 'PATCH').map((c: any[]) => JSON.parse(c[1].body));

afterEach(() => { cleanup(); toastSpy.mockReset(); });

describe('the words (pure)', () => {
  it('offLine names the schedule it WOULD keep, or just says off', () => {
    expect(offLine('Every day at 23:00')).toBe('Off — it will not run on its own. Would run every day at 23:00.');
    expect(offLine('')).toBe('Off — it will not run on its own.');
    expect(offLine(null)).toBe('Off — it will not run on its own.');
  });
  it('scheduleSavedToast says "switched on" only when the save flipped the switch', () => {
    expect(scheduleSavedToast('Every day at 23:00', true, true)).toBe('Saved and switched on — Every day at 23:00');
    expect(scheduleSavedToast('Every day at 23:00', false, true)).toBe('Saved — Every day at 23:00');
    expect(scheduleSavedToast('Every day at 23:00', true, false)).toBe('Saved — Every day at 23:00'); // system-paused: stays off
    expect(scheduleSavedToast('', true, false)).toBe('Saved — manual only');
  });
});

describe('the switch in the header (BEA-1603)', () => {
  it('WHEN an agent is off: the switch reads Off and the line says it will not run on its own, naming the schedule — no "next:"', async () => {
    mount(OFF_AGENT);
    await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy());
    const sw = screen.getByRole('checkbox', { name: /switch it on/i }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(screen.getByTestId('agent-switch').textContent).toContain('Off');
    expect(screen.getByTestId('off-line').textContent).toBe('Off — it will not run on its own. Would run every day at 23:00.');
    expect(screen.queryByText(/next:/)).toBeNull();
    // Off by HIS hand is not a system pause — the amber banner stays for pausedReason only.
    expect(screen.queryByTestId('paused-banner')).toBeNull();
  });

  it('an off agent with no schedule says only that it is off', async () => {
    mount({ ...OFF_AGENT, schedule: null, scheduleText: null });
    await waitFor(() => expect(screen.getByTestId('off-line')).toBeTruthy());
    expect(screen.getByTestId('off-line').textContent).toBe('Off — it will not run on its own.');
  });

  it('WHEN an agent is on: the switch reads On and the schedule line reads exactly as today', async () => {
    mount(ON_AGENT);
    await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy());
    const sw = screen.getByRole('checkbox', { name: /switch it off/i }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    expect(screen.getByTestId('agent-switch').textContent).toContain('On');
    expect(screen.queryByTestId('off-line')).toBeNull();
    await waitFor(() => expect(screen.getByText(/^Every day at 23:00 · Asia\/Kolkata · next: (today|tomorrow) 23:00$/)).toBeTruthy());
  });

  it('tapping the switch PATCHes { enabled } through the existing route and toasts Switched on / Switched off', async () => {
    const fetchMock = mount(OFF_AGENT);
    await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy());
    fireEvent.click(screen.getByRole('checkbox', { name: /switch it on/i }));
    await waitFor(() => expect(patchCalls(fetchMock, 'ec3')).toEqual([{ enabled: true }]));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', 'Switched on'));
    // …and the page now reads as an ON agent: the off line is gone, the switch is checked.
    await waitFor(() => expect(screen.queryByTestId('off-line')).toBeNull());
    expect((screen.getByRole('checkbox', { name: /switch it off/i }) as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: /switch it off/i }));
    await waitFor(() => expect(patchCalls(fetchMock, 'ec3')).toEqual([{ enabled: true }, { enabled: false }]));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', 'Switched off'));
    await waitFor(() => expect(screen.getByTestId('off-line')).toBeTruthy());
  });

  it('the system-pause banner stays exactly as it is, next to the Off line', async () => {
    mount({ ...OFF_AGENT, pausedReason: 'Its worker keeps failing.' });
    await waitFor(() => expect(screen.getByTestId('paused-banner')).toBeTruthy());
    expect(screen.getByText('Switch back on')).toBeTruthy();
    expect(screen.getByTestId('off-line')).toBeTruthy();
  });
});

describe('the phone fits (BEA-1603 — the UI gate at 390px)', () => {
  it('a failed history row clips its own words — the red text is the truncating block, not an inline child that runs off screen', async () => {
    const long = 'The AI could not be reached just now — nothing was written and nothing was sent, try again in a moment.';
    mount(ON_AGENT, '', [
      { id: 'r1', agentId: 'on1', status: 'failed', error: long, startedAt: '2026-08-29T17:30:00Z', endedAt: '2026-08-29T17:31:00Z' },
      { id: 'r2', agentId: 'on1', status: 'done', resultText: 'Created the daily email report.', startedAt: '2026-08-28T17:30:00Z', endedAt: '2026-08-28T17:31:00Z' },
    ]);
    const el = await screen.findByTestId('run-failed-words');
    expect(el.className).toContain('block');
    expect(el.className).toContain('truncate');
    expect(el.textContent).toMatch(/^Failed — The AI could not be reached/);
  });

  it('the name wraps on the phone and stays one line on the laptop, so the switch beside it never leaves "Daily E…"', async () => {
    mount(OFF_AGENT);
    await waitFor(() => expect(screen.getByTestId('agent-switch')).toBeTruthy());
    const h1 = screen.getByRole('heading', { level: 1 });
    expect(h1.textContent).toBe('Daily Email Agent');
    expect(h1.className).toContain('whitespace-normal');
    expect(h1.className).toContain('sm:whitespace-nowrap');
    expect(h1.className).toContain('truncate');
  });
});

describe('saving a schedule on an off agent (BEA-1603)', () => {
  it('WHEN a schedule is saved on an off agent, the toast says "Saved and switched on — …" and the page reads On', async () => {
    const fetchMock = mount({ ...OFF_AGENT, schedule: null, scheduleText: null }, '?tab=settings');
    await waitFor(() => expect(screen.getByTestId('srow-schedule')).toBeTruthy());
    fireEvent.click(screen.getByTestId('srow-schedule-summary').closest('summary')!);
    // The picker's first control is the repeat mode; picking "day" saves at once.
    const selects = screen.getByTestId('srow-schedule').querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'day' } });
    await waitFor(() => expect(patchCalls(fetchMock, 'ec3').some((b: any) => b.schedule?.every === 'day')).toBe(true));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', expect.stringMatching(/^Saved and switched on — /)));
    await waitFor(() => expect(screen.queryByTestId('off-line')).toBeNull());
  });

  it('WHEN a schedule is saved on a SYSTEM-paused agent, it stays off — the toast is the plain "Saved — …"', async () => {
    const fetchMock = mount({ ...OFF_AGENT, schedule: null, scheduleText: null, pausedReason: 'Its worker keeps failing.' }, '?tab=settings');
    await waitFor(() => expect(screen.getByTestId('srow-schedule')).toBeTruthy());
    fireEvent.click(screen.getByTestId('srow-schedule-summary').closest('summary')!);
    const selects = screen.getByTestId('srow-schedule').querySelectorAll('select');
    fireEvent.change(selects[0], { target: { value: 'day' } });
    await waitFor(() => expect(patchCalls(fetchMock, 'ec3').some((b: any) => b.schedule?.every === 'day')).toBe(true));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith('success', expect.stringMatching(/^Saved — /)));
    expect(toastSpy).not.toHaveBeenCalledWith('success', expect.stringMatching(/switched on/));
    expect(screen.getByTestId('off-line')).toBeTruthy();
    expect(screen.getByTestId('paused-banner')).toBeTruthy();
  });
});
