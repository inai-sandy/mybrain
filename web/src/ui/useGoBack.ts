import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * True "Back": return to wherever the user actually came from, instead of a hardcoded route (BEA-1001).
 * If this page was reached by in-app navigation there's real history to pop; a deep link / fresh tab
 * (`location.key === 'default'`) has none, so we fall back to a sensible parent page.
 * Factored out of the DocumentView/NoteView pattern (BEA-592).
 */
export function useGoBack(fallback = '/') {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (location.key && location.key !== 'default') navigate(-1);
    else navigate(fallback);
  }, [navigate, location.key, fallback]);
}
