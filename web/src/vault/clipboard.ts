// Copy a secret to the clipboard, then auto-clear it after ~30s so it doesn't linger.
// Best-effort: if a later copy happens, the previous clear is cancelled (only the latest wins).
export const CLIP_CLEAR_MS = 30_000;

let clearTimer: ReturnType<typeof setTimeout> | undefined;

export async function copySecret(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(() => {
    // Overwrite whatever we put there. We can't read the clipboard to confirm, so this is best-effort.
    navigator.clipboard.writeText('').catch(() => undefined);
    clearTimer = undefined;
  }, CLIP_CLEAR_MS);
}

export function maskOf(value: string): string {
  if (!value) return '';
  return '•'.repeat(Math.min(12, Math.max(6, value.length)));
}
