import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentAreaPage } from './AgentAreaPage';

/**
 * HONEST WORDS ON THE BOARD (BEA-1603). A job he switched off (or that was born off) is "off" — not
 * "paused", which reads as if it will come back by itself. A job the SYSTEM stopped keeps "paused
 * itself". Words only; nothing else on the board changes.
 */
vi.mock('../ui/Toast', () => ({ useToast: () => vi.fn() }));
vi.mock('../ui/ToolPicker', () => ({ ToolPicker: () => null }));
vi.mock('./NewJobChat', () => ({ NewJobChat: () => null }));
vi.mock('../ui/DictateButton', () => ({ DictateButton: () => null }));

const area = {
  id: 'ar1', name: 'Email', description: 'Reads his mail', outcome: '', tools: [],
  jobs: [
    { id: 'j1', name: 'Daily Email Agent', enabled: false, pausedReason: null, lastRun: null, scheduleText: 'Every day at 23:00' },
    { id: 'j2', name: 'Broken one', enabled: false, pausedReason: 'Its worker keeps failing', lastRun: null },
    { id: 'j3', name: 'Live one', enabled: true, pausedReason: null, lastRun: null },
  ],
};

afterEach(() => cleanup());

describe('the area page pill (BEA-1603)', () => {
  it('an off job says "off"; a system-paused one still says "paused itself"; an on job has no pill', async () => {
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      if (String(url) === '/api/agent/areas/ar1') return { ok: true, json: async () => area };
      return { ok: true, json: async () => ({}) };
    });
    render(<MemoryRouter initialEntries={['/agent/ar/ar1']}><Routes><Route path="/agent/ar/:id" element={<AgentAreaPage />} /></Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Daily Email Agent')).toBeTruthy());
    expect(screen.getByText('off')).toBeTruthy();
    expect(screen.getByText('paused itself')).toBeTruthy();
    expect(screen.queryByText('paused')).toBeNull();
    expect(screen.getAllByText(/^(off|paused itself)$/)).toHaveLength(2);
  });
});
