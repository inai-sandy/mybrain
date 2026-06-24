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
