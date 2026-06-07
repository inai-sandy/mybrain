/**
 * Publish an item as a public link, then open the native share sheet (Web Share API)
 * or fall back to copying the link. Returns what happened so the caller can toast.
 */
export async function shareItem(id: string, title: string): Promise<'shared' | 'copied' | 'cancelled' | 'error'> {
  try {
    await fetch(`/api/items/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shared: true }),
    });
  } catch {
    /* ignore — still attempt to share/copy the link */
  }
  const url = `${location.origin}/view/${id}`;
  const nav = navigator as any;
  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title: title || 'My Brain', url });
      return 'shared';
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelled';
      /* fall through to copy */
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'error';
  }
}
