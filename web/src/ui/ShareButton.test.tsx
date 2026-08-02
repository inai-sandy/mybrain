import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShareButton } from './ShareButton';

/**
 * BEA-1264 — sharing has to be one tap.
 *
 * Copying a URL out of the address bar on a phone is the difference between sending something and
 * not bothering. This confirms inline rather than through a Toast, because it also runs on the
 * public paper — a page a stranger reaches with no session and no app shell around it.
 */

const ORIGIN = 'https://mybrain.1site.ai';

beforeEach(() => {
  Object.defineProperty(window, 'location', { value: { origin: ORIGIN }, writable: true });
  // jsdom has neither by default; each test opts in to the one it is about.
  (navigator as any).share = undefined;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => undefined) }, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

const show = (url = '/paper/2026-07-31') =>
  render(<ShareButton url={url} title="AI News Daily — DeepSeek resets the price war" text="One thing happened." />);

describe('sharing a link (BEA-1264)', () => {
  it('uses the phone\'s own share sheet when there is one', async () => {
    const share = vi.fn(async () => undefined);
    (navigator as any).share = share;
    show();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() =>
      expect(share).toHaveBeenCalledWith(expect.objectContaining({ url: `${ORIGIN}/paper/2026-07-31` })),
    );
  });

  it('falls back to the clipboard, and says it worked', async () => {
    show();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('Link copied')).toBeTruthy());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${ORIGIN}/paper/2026-07-31`);
  });

  it('always shares an ABSOLUTE url — a relative one is useless in a message', async () => {
    show('/paper/2026-07-31');
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\//)));
  });

  it('leaves an already-absolute url alone', async () => {
    show('https://example.test/paper/x');
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://example.test/paper/x'));
  });

  it('cancelling the share sheet is not treated as a failure', async () => {
    // Backing out of the sheet is an ordinary thing to do; flashing an error at someone for it
    // would be the app telling them off for changing their mind.
    (navigator as any).share = vi.fn(async () => {
      const e: any = new Error('cancelled');
      e.name = 'AbortError';
      throw e;
    });
    show();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect((navigator as any).share).toHaveBeenCalled());
    expect(screen.queryByText(/Could not copy/)).toBeNull();
    expect(screen.queryByText('Link copied')).toBeNull();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('a real share failure still falls back to copying', async () => {
    (navigator as any).share = vi.fn(async () => { throw new Error('not allowed'); });
    show();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText('Link copied')).toBeTruthy());
  });

  it('says what to do when even the clipboard is blocked', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
    show();
    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(screen.getByText(/select the address bar/)).toBeTruthy());
  });
});
