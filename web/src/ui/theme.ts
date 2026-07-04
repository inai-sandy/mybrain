import { useEffect, useSyncExternalStore } from 'react';

const KEY = 'mybrain-theme';
export type Theme = 'light' | 'dark';

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

// Shared module-level store so EVERY useTheme() consumer (header menu, Settings) sees the same value.
// Previously each held its own useState copy, so changing the theme in one left the other stale and
// its first tap was a no-op (you had to tap twice). (BEA-820)
let current: Theme = ((typeof localStorage !== 'undefined' && (localStorage.getItem(KEY) as Theme)) || 'dark');
const listeners = new Set<() => void>();
if (typeof document !== 'undefined') applyTheme(current);

function setTheme(t: Theme) {
  if (t === current) return;
  current = t;
  applyTheme(t);
  try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, () => current, () => current);
  useEffect(() => { applyTheme(theme); }, [theme]); // keep the DOM class in sync on mount + change
  return { theme, toggle: () => setTheme(current === 'dark' ? 'light' : 'dark'), set: setTheme };
}
