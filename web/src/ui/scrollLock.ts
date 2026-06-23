// Reference-counted scroll lock for the app's scroll container.
//
// Since BEA-484 the document body no longer scrolls — the app is a fixed-height
// shell and the element `#app-scroll` (the <main>) is the real scroller. So a
// modal/sheet locks THAT element, not the body.
//
// The recurring trap (the Tasks "stopped scrolling" bug): when two sheets briefly
// overlap, a per-instance lock can capture the ALREADY-LOCKED state as its
// "previous" and re-lock on close. The fix is one shared, ref-counted lock —
// only the FIRST lock captures the real style; only the LAST unlock restores it.

let count = 0;
let savedOverflow: string | null = null;
let el: HTMLElement | null = null;

function scroller(): HTMLElement | null {
  return document.getElementById('app-scroll');
}

export function lockBodyScroll(): void {
  if (count === 0) {
    el = scroller();
    if (el) {
      savedOverflow = el.style.overflow;
      el.style.overflow = 'hidden';
    }
  }
  count++;
}

export function unlockBodyScroll(): void {
  count = Math.max(0, count - 1);
  if (count === 0) {
    if (el && savedOverflow !== null) el.style.overflow = savedOverflow;
    savedOverflow = null;
    el = null;
  }
}
