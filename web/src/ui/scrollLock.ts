// Reference-counted body scroll lock.
//
// Modals/sheets pin the page with position:fixed so iOS doesn't jump to the top
// while one is open. The trap: when two sheets briefly overlap (e.g. the dump
// modal animating out while the review sheet mounts), a per-instance lock makes
// the second sheet capture the ALREADY-LOCKED body as its "previous" style — so
// closing it RE-LOCKS the page and scrolling dies. That's the recurring Tasks
// "stopped scrolling" bug.
//
// The fix: one shared lock. Only the FIRST lock captures the real (unlocked)
// style + scroll position; only the LAST unlock restores them. Any number of
// stacked sheets is safe.

type Saved = { position: string; top: string; left: string; right: string; width: string; overflow: string };

let count = 0;
let savedY = 0;
let saved: Saved | null = null;

export function lockBodyScroll(): void {
  if (count === 0) {
    savedY = window.scrollY;
    const b = document.body.style;
    saved = { position: b.position, top: b.top, left: b.left, right: b.right, width: b.width, overflow: b.overflow };
    b.position = 'fixed';
    b.top = `-${savedY}px`;
    b.left = '0';
    b.right = '0';
    b.width = '100%';
    b.overflow = 'hidden';
  }
  count++;
}

/** True while any sheet/modal has the body locked — used to suppress edge-swipe-back. (BEA-821) */
export function isBodyScrollLocked(): boolean {
  return count > 0;
}

export function unlockBodyScroll(): void {
  count = Math.max(0, count - 1);
  if (count === 0 && saved) {
    const b = document.body.style;
    b.position = saved.position;
    b.top = saved.top;
    b.left = saved.left;
    b.right = saved.right;
    b.width = saved.width;
    b.overflow = saved.overflow;
    saved = null;
    window.scrollTo(0, savedY);
  }
}
