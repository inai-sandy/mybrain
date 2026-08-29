import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { Agents, NewAgentForm } from './Agents';

/**
 * BEA-1380 folders on the Agents home, laid out per BEA-1383: ONE horizontal chips row at every
 * width (the laptop left rail is REMOVED) renders All · folders · Unfiled with counts and scrolls
 * sideways inside its own container; picking a folder narrows the grid, the card menu moves one
 * agent, multi-select moves several, and an agent created from inside a folder carries that folder
 * onto the create call.
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../ui/DictateButton', () => ({ DictateButton: () => null }));
vi.mock('../ui/push', () => ({ enablePush: async () => ({ ok: true }), pushPermission: () => 'denied', pushEnabledHere: async () => false }));
vi.mock('./AgentBuilder', () => ({ AgentBuilder: () => null, withCreatedFlag: (u: string) => u }));
vi.mock('./social/AddSourcePanel', () => ({ AddSourcePanel: () => null }));

// One job each, because that is what a real area has. An area with NOTHING in it is an unfinished
// draft and the list deliberately keeps those out (BEA-1564, `isDraftShell`) — these fixtures were
// written to exercise FOLDERS and had simply left the jobs off.
const areas = [
  { id: 'a1', name: 'Radar', description: '', folderId: 'f1', jobs: [{ id: 'j1', name: 'Radar job' }], jobCount: 1, tools: [] },
  { id: 'a2', name: 'Sheets', description: '', folderId: null, jobs: [{ id: 'j2', name: 'Sheets job' }], jobCount: 1, tools: [] },
];
const folders = { folders: [{ id: 'f1', name: 'Work', order: 1, count: 1 }], all: 2, unfiled: 1 };

function mockApi(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockImplementation(async (url: any, init?: any) => {
    const u = String(url);
    const body = () => {
      if (u.includes('/api/agent/engine')) return { ok: true };
      if (u.includes('/api/agent/home')) return { waiting: [], running: [], landed: [], agents: [] };
      if (u.includes('/api/agent/folders')) return folders;
      if (u.includes('/api/agent/areas')) return areas;
      return {};
    };
    return { ok: true, json: async () => body() } as any;
  });
}

describe('the folder chips row (BEA-1380 · layout BEA-1383)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); (globalThis as any).fetch = fetchMock; mockApi(fetchMock); });
  afterEach(() => cleanup());

  it('renders ONE chips row — All · Work · Unfiled with counts + New folder — and no left rail at any width', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('folder-chips')).toBeTruthy());
    // The BEA-1380 laptop left rail is gone for good (BEA-1383) — one shape at every width.
    expect(screen.queryByTestId('folder-rail')).toBeNull();
    const chips = within(screen.getByTestId('folder-chips'));
    expect(chips.getByText('All')).toBeTruthy();
    expect(chips.getByText('Work')).toBeTruthy();
    expect(chips.getByText('Unfiled')).toBeTruthy();
    expect(chips.getByText('New folder')).toBeTruthy();
    // counts: All 2 · Work 1 · Unfiled 1
    expect(chips.getByText('2')).toBeTruthy();
    expect(chips.getAllByText('1').length).toBe(2);
  });

  it('the row scrolls sideways inside its own container (overflow-x-auto), never the page', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('folder-chips')).toBeTruthy());
    const row = screen.getByRole('tablist', { name: 'Agent folders' });
    expect(row.className).toContain('overflow-x-auto');
    // Chips must not wrap into a tall block.
    expect(row.className).not.toContain('flex-wrap');
  });

  it('rename + delete stay reachable from the ACTIVE folder chip', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('folder-chips')).toBeTruthy());
    const chips = within(screen.getByTestId('folder-chips'));
    expect(chips.queryByLabelText('Rename folder Work')).toBeNull(); // not active yet
    fireEvent.click(chips.getByText('Work'));
    await waitFor(() => expect(chips.getByLabelText('Rename folder Work')).toBeTruthy());
    expect(chips.getByLabelText('Delete folder Work')).toBeTruthy();
  });

  it('picking a folder shows only its agents; Unfiled shows the rest; All shows everything', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Radar')).toBeTruthy());
    expect(screen.getByText('Sheets')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('folder-chips')).getByText('Work'));
    await waitFor(() => expect(screen.queryByText('Sheets')).toBeNull());
    expect(screen.getByText('Radar')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('folder-chips')).getByText('Unfiled'));
    await waitFor(() => expect(screen.queryByText('Radar')).toBeNull());
    expect(screen.getByText('Sheets')).toBeTruthy();

    fireEvent.click(within(screen.getByTestId('folder-chips')).getByText('All'));
    await waitFor(() => expect(screen.getByText('Radar')).toBeTruthy());
    expect(screen.getByText('Sheets')).toBeTruthy();
  });

  it('the auto-category shelves are gone — the grid is one flat list under the folder nav', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Radar')).toBeTruthy());
    // No shelf headings like "Daily" / "Research" — only the folder nav organizes the page.
    expect(screen.queryByText('Daily')).toBeNull();
    expect(screen.queryByText('Research')).toBeNull();
  });
});

describe('moving agents into folders (BEA-1380)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); (globalThis as any).fetch = fetchMock; mockApi(fetchMock); });
  afterEach(() => cleanup());

  it('card menu → Move to folder… → pick → PATCHes that area with the folder id', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Sheets')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Actions for Sheets'));
    fireEvent.click(screen.getByText('Move to folder…'));
    const picker = within(await screen.findByTestId('folder-picker'));
    fireEvent.click(picker.getByText('Work'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/agent/areas/a2' && c[1]?.method === 'PATCH');
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body)).toEqual({ folderId: 'f1' });
    });
  });

  it('multi-select two cards → the bulk bar → Move to… → one bulk move call with both ids', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Radar')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Select Radar'));
    fireEvent.click(screen.getByLabelText('Select Sheets'));
    const bar = within(screen.getByTestId('bulk-bar'));
    expect(bar.getByText('2 selected')).toBeTruthy();
    fireEvent.click(bar.getByText('Move to…'));
    const picker = within(await screen.findByTestId('folder-picker'));
    fireEvent.click(picker.getByText('Work'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/agent/areas/move' && c[1]?.method === 'POST');
      expect(call).toBeTruthy();
      const body = JSON.parse(call![1].body);
      expect(body.folderId).toBe('f1');
      expect([...body.ids].sort()).toEqual(['a1', 'a2']);
    });
  });

  it('ticking a card and clearing the selection brings the normal card taps back', async () => {
    render(<MemoryRouter initialEntries={['/agent']}><Agents /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Radar')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Select Radar'));
    expect(screen.getByTestId('bulk-bar')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByTestId('bulk-bar')).toBeNull();
  });
});

describe('creating from inside a folder (BEA-1380)', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); (globalThis as any).fetch = fetchMock; });
  afterEach(() => cleanup());

  it('NewAgentForm sends the current folder on the create call', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'new1' }) });
    render(<MemoryRouter><NewAgentForm folderId="f1" onCreated={() => undefined} onCancel={() => undefined} /></MemoryRouter>);
    fireEvent.click(screen.getByText('Fill it in myself'));
    fireEvent.change(screen.getByPlaceholderText('Agent name (e.g. Morning Brief)'), { target: { value: 'My radar' } });
    fireEvent.change(screen.getByPlaceholderText('What should it do each time it runs?'), { target: { value: 'Fetch things' } });
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/agent/agents' && c[1]?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(call![1].body).folderId).toBe('f1');
    });
  });

  it('without a folder open, no folderId rides on the create', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: 'new1' }) });
    render(<MemoryRouter><NewAgentForm onCreated={() => undefined} onCancel={() => undefined} /></MemoryRouter>);
    fireEvent.click(screen.getByText('Fill it in myself'));
    fireEvent.change(screen.getByPlaceholderText('Agent name (e.g. Morning Brief)'), { target: { value: 'My radar' } });
    fireEvent.change(screen.getByPlaceholderText('What should it do each time it runs?'), { target: { value: 'Fetch things' } });
    fireEvent.click(screen.getByText('Save agent'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/agent/agents' && c[1]?.method === 'POST');
      expect(call).toBeTruthy();
      expect('folderId' in JSON.parse(call![1].body)).toBe(false);
    });
  });
});
