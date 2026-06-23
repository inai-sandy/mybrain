import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { Sheet } from './Sheet';

// Since BEA-484 the scroll lock targets the app's inner scroller (#app-scroll), not the body —
// the document no longer scrolls in the app shell. These tests reflect that model.
describe('Sheet scroll lock', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app-scroll"></div>';
  });

  it('locks the inner scroller while open and restores it on close', () => {
    const scroller = () => document.getElementById('app-scroll')!;
    expect(scroller().style.overflow).toBe('');

    const { unmount } = render(<Sheet onClose={() => {}}>{() => <div>content</div>}</Sheet>);
    expect(scroller().style.overflow).toBe('hidden');

    unmount();
    expect(scroller().style.overflow).toBe('');
  });

  it('stays locked through STACKED sheets, releases only on the last close (the Tasks "stopped scrolling" bug)', () => {
    const scroller = () => document.getElementById('app-scroll')!;

    // Sheet A opens and locks the scroller.
    const a = render(<Sheet onClose={() => {}}>{() => <div>A</div>}</Sheet>);
    // Sheet B mounts while A is still on screen — the dump→review overlap.
    const b = render(<Sheet onClose={() => {}}>{() => <div>B</div>}</Sheet>);
    expect(scroller().style.overflow).toBe('hidden');

    // A unmounts first; B is still open, so the scroller MUST stay locked.
    a.unmount();
    expect(scroller().style.overflow).toBe('hidden');

    // B closes — only now is it released. (A per-instance lock would re-lock here.)
    b.unmount();
    expect(scroller().style.overflow).toBe('');
  });
});
