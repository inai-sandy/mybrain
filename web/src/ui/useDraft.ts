import { useEffect, useRef } from 'react';

// Auto-save a text draft to localStorage so an accidental close / reload / phone hiccup never loses it. (BEA-512)
// Usage: initialise state with loadDraft(key), call useDraftPersist(key, value), and clearDraft(key) on success.

export function loadDraft(key: string): string {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}

export function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * The same idea for a whole form's worth of state, not just one box. (BEA-1165)
 *
 * The Close-day wizard holds the story, which step he's on, and every tick across four steps — all
 * of it in memory only, so a reload sent him back to a blank box. This keeps the lot.
 *
 * Deliberately on the device rather than the server: the moment things "go wrong" is usually the
 * moment the network is down, and a save that needs the server is no save at all.
 */
export function loadObjectDraft<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null; // a corrupt draft is no draft — never block him from starting
  }
}

export function saveObjectDraft(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or private mode — losing the draft is bad, crashing the wizard is worse */
  }
}

/** Debounced persist of `value` under `key`; removes the key when the value is blank. */
export function useDraftPersist(key: string, value: string): void {
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      try {
        if (value.trim()) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }, 400);
    return () => window.clearTimeout(timer.current);
  }, [key, value]);
}

/**
 * Debounced persist of any object under `key`, stamped with the time it was written. (BEA-1165)
 *
 * Three things this has to get right:
 *
 * `enabled` is re-read when the timer FIRES, not only when the effect runs — turning it off must
 * stop a save that is already queued, or clearing a draft after a successful save is undone 400ms
 * later and the finished form comes back.
 *
 * The timer keys off the CONTENT, not the object identity. Callers pass a fresh object literal on
 * every render, so depending on identity restarts the countdown on renders that changed nothing —
 * and a form that is re-rendering steadily would never actually save.
 *
 * It flushes on the way out: unmount, tab hidden, or page unload write immediately. A debounce that
 * only ever fires on a timer loses the last 400ms of typing, which is exactly the moment a crash
 * takes with it.
 */
export function useObjectDraftPersist(key: string, value: unknown, enabled = true): void {
  const timer = useRef<number | undefined>(undefined);
  const on = useRef(enabled);
  const latest = useRef<string>('');
  on.current = enabled;
  const json = JSON.stringify(value ?? null);
  latest.current = json;

  const flush = () => {
    window.clearTimeout(timer.current);
    if (!on.current) return;
    try {
      localStorage.setItem(key, JSON.stringify({ ...JSON.parse(latest.current), at: Date.now() }));
    } catch {
      /* quota, private mode, or a non-object value — never crash the form over a draft */
    }
  };

  useEffect(() => {
    if (!enabled) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 400);
    return () => window.clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, json, enabled]);

  useEffect(() => {
    const bye = () => flush();
    window.addEventListener('pagehide', bye);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && bye());
    return () => {
      window.removeEventListener('pagehide', bye);
      bye(); // unmounting counts as leaving
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
