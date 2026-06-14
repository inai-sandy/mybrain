import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Sheet } from './Sheet';

describe('Sheet scroll lock', () => {
  it('pins the body at the current scroll position and restores it on close (iOS jump-to-top regression)', () => {
    Object.defineProperty(window, 'scrollY', { value: 350, configurable: true });
    const scrollTo = vi.fn();
    window.scrollTo = scrollTo as any;

    const { unmount } = render(<Sheet onClose={() => {}}>{() => <div>content</div>}</Sheet>);
    // while open: body is pinned exactly where the user was, not just overflow-hidden
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-350px');

    unmount();
    // on close: styles restored and the page is put back where it was
    expect(document.body.style.position).toBe('');
    expect(scrollTo).toHaveBeenCalledWith(0, 350);
  });

  it('stays unlocked after STACKED sheets close (the recurring Tasks "stopped scrolling" bug)', () => {
    Object.defineProperty(window, 'scrollY', { value: 200, configurable: true });
    window.scrollTo = vi.fn() as any;

    // Sheet A opens and locks the page.
    const a = render(<Sheet onClose={() => {}}>{() => <div>A</div>}</Sheet>);
    // Sheet B mounts while A is still on screen — this is the dump→review overlap.
    const b = render(<Sheet onClose={() => {}}>{() => <div>B</div>}</Sheet>);
    expect(document.body.style.position).toBe('fixed');

    // A unmounts first (its exit animation finishes). B is still open, so the page MUST stay locked.
    a.unmount();
    expect(document.body.style.position).toBe('fixed');

    // B closes — only now is the page fully released. (A per-instance lock would re-lock here.)
    b.unmount();
    expect(document.body.style.position).toBe('');
    expect(document.body.style.overflow).toBe('');
  });
});
