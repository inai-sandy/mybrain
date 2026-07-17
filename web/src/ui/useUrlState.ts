import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * A piece of view-state (a filter, search text, tab, page) mirrored into the URL query string so that
 * leaving a list and pressing Back returns to the EXACT same view (BEA-1001). Previously these lived in
 * local useState, so Back re-mounted the page fresh — filters cleared, top of the list.
 *
 * Writes use `replace: true` so typing in a filter doesn't stack dozens of history entries. A value equal
 * to its default is dropped from the URL entirely, keeping links clean.
 */
export function useUrlState(key: string, defaultValue = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? defaultValue;
  const setValue = useCallback((v: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!v || v === defaultValue) next.delete(key);
      else next.set(key, v);
      return next;
    }, { replace: true });
  }, [key, defaultValue, setParams]);
  return [value, setValue];
}

/** Boolean variant — stored as "1" when on, absent when off. */
export function useUrlBool(key: string): [boolean, (v: boolean) => void] {
  const [raw, setRaw] = useUrlState(key, '');
  return [raw === '1', (v: boolean) => setRaw(v ? '1' : '')];
}
