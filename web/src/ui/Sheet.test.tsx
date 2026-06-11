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
});
