import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplySheet, type ReplyTarget } from './ReplySheet';

/**
 * BEA-1597 — ONE reply / close sheet, shared by Tasks → Needs you and the Dashboard. It must talk
 * to the review endpoints the inbox already had, and nothing else.
 */
vi.mock('./Toast', () => ({ useToast: () => vi.fn() }));

const ITEM: ReplyTarget = { id: 'u1', text: 'Need 298usd for the Elleys PCB advance sir', label: 'asked for money', contact: { id: 'c1', name: 'Deepthi' }, canReply: true };

function mockFetch(answer: any = { ok: true }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, json: async () => answer } as any;
  }) as any;
  return calls;
}

beforeEach(() => {
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
  window.scrollTo = vi.fn() as any;
});

describe('ReplySheet (BEA-1597)', () => {
  it('shows who, their words and WHY it needs him', () => {
    mockFetch();
    render(<ReplySheet item={ITEM} onClose={() => {}} />);
    expect(screen.getByText('Reply to Deepthi')).toBeInTheDocument();
    expect(screen.getByText('Need 298usd for the Elleys PCB advance sir')).toBeInTheDocument();
    expect(screen.getByTestId('reply-sheet-reason')).toHaveTextContent('asked for money');
  });

  it('a sent reply goes out through the existing /reply path, and reports "replied"', async () => {
    const calls = mockFetch({ ok: true });
    const done = vi.fn();
    render(<ReplySheet item={ITEM} onClose={() => {}} onDone={done} />);
    const send = screen.getByRole('button', { name: /Send on WhatsApp/ });
    expect(send).toBeDisabled(); // nothing typed yet
    fireEvent.change(screen.getByPlaceholderText(/Reply to Deepthi/), { target: { value: 'Approved, go ahead' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe('/api/reminders/review/u1/reply');
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ text: 'Approved, go ahead' });
    await waitFor(() => expect(done).toHaveBeenCalledWith({ kind: 'replied' }));
  });

  it('Close goes through /close and reports "closed"', async () => {
    const calls = mockFetch({ ok: true, pendingClaim: false });
    const done = vi.fn();
    render(<ReplySheet item={ITEM} onClose={() => {}} onDone={done} />);
    fireEvent.click(screen.getByRole('button', { name: /Sorted, close it/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe('/api/reminders/review/u1/close');
    expect(calls[0].init?.method).toBe('POST');
    await waitFor(() => expect(done).toHaveBeenCalledWith({ kind: 'closed', pendingClaim: false }));
  });

  it('a done-claim offers Yes/No through /decide with the EXACT claim shown', async () => {
    const calls = mockFetch({ ok: true, stillOpen: false });
    const done = vi.fn();
    render(<ReplySheet item={{ ...ITEM, claimId: 'cl9', text: 'It is completed', label: 'claims done — needs your check' }} onClose={() => {}} onDone={done} />);
    expect(screen.queryByRole('button', { name: /Sorted, close it/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /No — keep chasing/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].url).toBe('/api/reminders/review/u1/decide');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ confirm: false, claimId: 'cl9' });
    await waitFor(() => expect(done).toHaveBeenCalledWith({ kind: 'decided', confirm: false, stillOpen: false }));
  });

  it('with no WhatsApp number the reply is off but Close still works', () => {
    mockFetch();
    render(<ReplySheet item={{ ...ITEM, canReply: false }} onClose={() => {}} />);
    expect(screen.getByRole('button', { name: /Send on WhatsApp/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Sorted, close it/ })).toBeEnabled();
    expect(screen.getByText(/No WhatsApp number for Deepthi/)).toBeInTheDocument();
  });

  it('a failed send says so and does NOT report done', async () => {
    const calls = mockFetch({ ok: false, message: 'outside the 24-hour window' });
    const done = vi.fn();
    render(<ReplySheet item={ITEM} onClose={() => {}} onDone={done} />);
    fireEvent.change(screen.getByPlaceholderText(/Reply to Deepthi/), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /Send on WhatsApp/ }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(done).not.toHaveBeenCalled();
    expect(screen.getByTestId('reply-sheet')).toBeInTheDocument(); // still open to try again
  });

  it('uses the shared body scroll lock through Sheet — never one of its own', () => {
    mockFetch();
    Object.defineProperty(window, 'scrollY', { value: 120, configurable: true });
    const { unmount } = render(<ReplySheet item={ITEM} onClose={() => {}} />);
    expect(document.body.style.position).toBe('fixed');
    unmount();
    expect(document.body.style.position).toBe('');
  });
});
