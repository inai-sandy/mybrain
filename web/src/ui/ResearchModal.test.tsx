import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResearchModal } from './ResearchModal';

/**
 * BEA-1258 — one research popup, wherever you press it.
 *
 * The owner: "the same pop-up which opens when I click on the research button on bookmarks has to
 * open and follow the same steps." It used to live inside Bookmarks; a news story needs the
 * identical thing. These lock the STEPS, so lifting it out cannot quietly change bookmarks.
 */

const navigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual: any = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => navigate };
});
const toast = vi.fn();
vi.mock('./Toast', () => ({ useToast: () => toast }));

function show(base = '/api/bookmarks/b1') {
  return render(
    <MemoryRouter>
      <ResearchModal title="DeepSeek ships V4-Flash" endpointBase={base} onClose={() => undefined} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  navigate.mockClear();
  toast.mockClear();
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ runs: [] }) })) as any;
});
afterEach(() => vi.restoreAllMocks());

describe('the research popup (BEA-1258)', () => {
  it('shows what you are researching and asks for it in your own words', async () => {
    show();
    expect(screen.getByText('Research this')).toBeTruthy();
    expect(screen.getByText('DeepSeek ships V4-Flash')).toBeTruthy();
    expect(screen.getByPlaceholderText(/in your own words/i)).toBeTruthy();
  });

  it('will not submit an empty question', () => {
    show();
    expect((screen.getByRole('button', { name: /create research job/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('creates a JOB in Research Agent and takes you there — created, not started', async () => {
    // The owner presses Run himself. A popup that silently started spending would be a different
    // feature from the one he approved.
    global.fetch = vi.fn(async (url: any, opts: any) =>
      opts?.method === 'POST'
        ? { ok: true, json: async () => ({ jobId: 'j9', url: '/agent/a/j9' }) }
        : { ok: true, json: async () => ({ runs: [] }) },
    ) as any;
    show();
    fireEvent.change(screen.getByPlaceholderText(/in your own words/i), { target: { value: 'how fast is it really' } });
    fireEvent.click(screen.getByRole('button', { name: /create research job/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/agent/a/j9'));
    expect(toast).toHaveBeenCalledWith('success', expect.stringContaining('press Run'));
  });

  it('posts to whatever endpoint it was given, so a news story uses the same popup', async () => {
    const calls: any[] = [];
    global.fetch = vi.fn(async (url: any, opts: any) => {
      calls.push([String(url), opts?.method]);
      return opts?.method === 'POST'
        ? { ok: true, json: async () => ({ jobId: 'j1' }) }
        : { ok: true, json: async () => ({ runs: [] }) };
    }) as any;
    show('/api/news/stories/s7');
    fireEvent.change(screen.getByPlaceholderText(/in your own words/i), { target: { value: 'dig in' } });
    fireEvent.click(screen.getByRole('button', { name: /create research job/i }));
    await waitFor(() => expect(calls.some(([u, m]) => u === '/api/news/stories/s7/research' && m === 'POST')).toBe(true));
  });

  it('shows a friendly message when the job cannot be created, never a raw crash', async () => {
    global.fetch = vi.fn(async (url: any, opts: any) =>
      opts?.method === 'POST'
        ? { ok: false, json: async () => ({ message: 'Story not found' }) }
        : { ok: true, json: async () => ({ runs: [] }) },
    ) as any;
    show();
    fireEvent.change(screen.getByPlaceholderText(/in your own words/i), { target: { value: 'dig in' } });
    fireEvent.click(screen.getByRole('button', { name: /create research job/i }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('error', 'Story not found'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('closes on Escape, like every other dialog', async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ResearchModal title="x" endpointBase="/api/bookmarks/b1" onClose={onClose} />
      </MemoryRouter>,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('lists past research so it is never lost', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ runs: [{ id: 'r1', title: 'Earlier dig', status: 'done', startedAt: new Date().toISOString(), outputDocId: 'd1' }] }),
    })) as any;
    show();
    await waitFor(() => expect(screen.getByText('Earlier dig')).toBeTruthy());
  });

  it('a failed lookup of past research does not stop you starting a new one', async () => {
    global.fetch = vi.fn(async (url: any, opts: any) => {
      if (opts?.method === 'POST') return { ok: true, json: async () => ({ jobId: 'j2' }) };
      throw new Error('offline');
    }) as any;
    show();
    fireEvent.change(screen.getByPlaceholderText(/in your own words/i), { target: { value: 'dig in' } });
    fireEvent.click(screen.getByRole('button', { name: /create research job/i }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/agent/a/j2'));
  });
});
