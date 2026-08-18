import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { FlowPanel, nodeResultsFromRun } from './AgentJobPanels';

/**
 * BEA-1366 — the Flow tab opens ON the picture. A Social agent's flow is machine-drawn: no
 * "Draw the flow"/"Re-draw" button, a "drawn from settings" note, the canvas read-only. A normal
 * agent's picture says "drawing…" while the planner works and "could not re-draw" (last picture
 * kept) when it fails. The legacy empty state keeps its one button, and it uses the one draw road.
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
// The canvas is heavy (@xyflow) and lazy — stand it in and record what it was given.
const editorProps: any[] = [];
vi.mock('./FlowEditor', () => ({ FlowEditor: (p: any) => { editorProps.push(p); return <div data-testid="canvas">canvas {p.readOnly ? 'read-only' : 'editable'}</div>; } }));

const socialFlow = {
  id: 'f1', agentId: 'a1', name: 'IG digest — how it runs', drawnBy: 'social', locked: true, drawStatus: null, drawNote: null, updatedAt: '2026-08-18T05:00:00Z',
  graph: { nodes: [{ id: 'question', data: { kind: 'question', label: 'IG digest' } }, { id: 'src:svc:instagram.search_hashtag', data: { kind: 'tool', label: 'Instagram · Search hashtag' } }, { id: 'write', data: { kind: 'tool', label: 'Google Sheet — new each run' } }, { id: 'end', data: { kind: 'output', label: 'Done' } }], edges: [] },
};
const normalFlow = { ...socialFlow, id: 'f2', name: 'Research flow', drawnBy: 'planner', locked: false };

describe('FlowPanel (BEA-1366)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    editorProps.length = 0;
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/prompt')) return { ok: true, json: async () => ({ prompt: 'p', process: { task: 't', branches: [] } }) };
      if (String(url).includes('/draw')) return { ok: true, json: async () => ({ flow: { ...normalFlow, drawStatus: 'drawing' } }) };
      return { ok: true, json: async () => ({}) };
    });
    (globalThis as any).fetch = fetchMock;
    (globalThis as any).innerWidth = 1180;
  });
  afterEach(() => cleanup());

  it('a Social agent: the picture is there with no button, marked drawn-from-settings, canvas read-only', async () => {
    render(<MemoryRouter><FlowPanel id="a1" flow={socialFlow} onChanged={() => undefined} goChat={() => undefined} /></MemoryRouter>);
    expect(screen.getByText(/drawn from this job’s settings/i)).toBeTruthy();
    expect(screen.queryByText('Draw the flow')).toBeNull();
    expect(screen.queryByText('Re-draw')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveTextContent('read-only'));
    expect(screen.getByText(/Not run yet/)).toBeTruthy();
  });

  it('a Social agent after a run: the last run is named and per-node results reach the canvas', async () => {
    const lastRun = { id: 'r1', status: 'done', startedAt: '2026-08-18T05:10:00Z', stepLog: [
      { label: 'Fetching directly — no engine turn for this', status: 'done', kind: 'log' },
      { label: 'Fetched Instagram · Search hashtag — 12 items · 2 credits', status: 'done', nodeId: 'src:svc:instagram.search_hashtag' },
      { label: 'Shaping the rows the way you asked', status: 'running', kind: 'log', nodeId: 'shape' },
      { label: 'Shaped 12 rows into 9 columns', status: 'done', nodeId: 'shape' },
      { label: 'Created a Google Sheet and wrote 12 rows', status: 'done', nodeId: 'write' },
      { label: 'WhatsApp not sent — no number in Settings', status: 'info', nodeId: 'notify' },
    ] };
    render(<MemoryRouter><FlowPanel id="a1" flow={socialFlow} onChanged={() => undefined} goChat={() => undefined} lastRun={lastRun} /></MemoryRouter>);
    expect(screen.getByText(/Last run/)).toBeTruthy();
    await waitFor(() => expect(editorProps.length).toBeGreaterThan(0));
    const rr = editorProps[editorProps.length - 1].runResults;
    expect(rr['src:svc:instagram.search_hashtag']).toEqual({ status: 'done', note: 'Fetched Instagram · Search hashtag — 12 items · 2 credits' });
    expect(rr.shape.status).toBe('done'); // the later step wins over "Shaping…"
    expect(rr.write.status).toBe('done');
    expect(rr.notify.status).toBe('skipped'); // said, not done
    expect(rr.question).toBeUndefined(); // log lines without a nodeId mark nothing
  });

  it('nodeResultsFromRun: a node left "running" by a failed run reads as failed', () => {
    const rr = nodeResultsFromRun({ status: 'failed', stepLog: [{ label: 'Shaping…', status: 'running', nodeId: 'shape' }] });
    expect(rr.shape.status).toBe('failed');
  });

  it('a normal agent: Re-draw stays, and it goes down the one draw road', async () => {
    const onChanged = vi.fn();
    render(<MemoryRouter><FlowPanel id="a1" flow={normalFlow} onChanged={onChanged} goChat={() => undefined} /></MemoryRouter>);
    expect(screen.queryByText(/drawn from this job’s settings/i)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('canvas')).toHaveTextContent('editable'));
    fireEvent.click(screen.getByText('Re-draw'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/flows/agents/a1/draw' && c[1]?.method === 'POST')).toBe(true));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('while the planner works: "drawing…" is said, Re-draw is disabled, and the panel keeps asking for the flow', async () => {
    vi.useFakeTimers();
    try {
      const onChanged = vi.fn();
      render(<MemoryRouter><FlowPanel id="a1" flow={{ ...normalFlow, drawStatus: 'drawing' }} onChanged={onChanged} goChat={() => undefined} /></MemoryRouter>);
      expect(screen.getByText(/Re-drawing the steps/)).toBeTruthy();
      expect((screen.getByText('Re-draw').closest('button') as HTMLButtonElement).disabled).toBe(true);
      vi.advanceTimersByTime(3100);
      expect(onChanged).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('a first draw with no nodes yet says "Drawing…" instead of an empty canvas', () => {
    render(<MemoryRouter><FlowPanel id="a1" flow={{ ...normalFlow, drawStatus: 'drawing', graph: { nodes: [], edges: [] } }} onChanged={() => undefined} goChat={() => undefined} /></MemoryRouter>);
    expect(screen.getByText(/Drawing the steps from what this job is asked to do/)).toBeTruthy();
    expect(screen.queryByTestId('canvas')).toBeNull();
  });

  it('planner failure: the last picture stays and the failure is said, with Try again', async () => {
    render(<MemoryRouter><FlowPanel id="a1" flow={{ ...normalFlow, drawStatus: 'failed', drawNote: 'Could not re-draw the flow — the last picture is kept. Try again.' }} onChanged={() => undefined} goChat={() => undefined} /></MemoryRouter>);
    expect(screen.getByText(/Could not re-draw the flow — the last picture is kept/)).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy()); // the picture is still shown
    fireEvent.click(screen.getByText('Try again'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/flows/agents/a1/draw')).toBe(true));
  });

  it('legacy agent with no flow: the one "Draw the flow" button remains and uses the same road', async () => {
    render(<MemoryRouter><FlowPanel id="a1" flow={null} onChanged={() => undefined} goChat={() => undefined} /></MemoryRouter>);
    fireEvent.click(screen.getByText('Draw the flow'));
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/flows/agents/a1/draw' && c[1]?.method === 'POST')).toBe(true));
    // never the old two-step create + plan
    expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/flows' && c[1]?.method === 'POST')).toBe(false);
    expect(fetchMock.mock.calls.some((c) => /\/plan$/.test(String(c[0])))).toBe(false);
  });

  it('phone: readable steps first, the canvas a tap away — for a Social agent too', async () => {
    (globalThis as any).innerWidth = 390;
    render(<MemoryRouter><FlowPanel id="a1" flow={socialFlow} onChanged={() => undefined} goChat={() => undefined} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Open canvas')).toBeTruthy());
    expect(screen.queryByTestId('canvas')).toBeNull();
    fireEvent.click(screen.getByText('Open canvas'));
    await waitFor(() => expect(screen.getByTestId('canvas')).toBeTruthy());
  });
});
