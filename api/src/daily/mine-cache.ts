import { createHash } from 'crypto';

/**
 * Fingerprint the story text a reading was made from. (BEA-1164)
 *
 * Why fingerprint rather than compare the text: a story can run to thousands of characters and this
 * is checked on every open of the wizard. A short hash answers the only question that matters —
 * "is this still the same story I read?" — without carrying the text around.
 *
 * Whitespace is normalised first, so re-wrapping a line or a stray double space does NOT count as
 * an edit. Anything he actually rewrote does.
 */
export function storyFingerprint(text: string | null | undefined): string {
  const norm = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/**
 * Decide what to do when the wizard asks to read a day.
 *
 * The rule the owner asked for: *"it should not run api calls repeatedly."* So a stored reading is
 * ALWAYS shown, and a changed story never silently spends a fresh call — it shows what we have and
 * says the story moved on. Only `force` (his own "Read it again") buys a new read.
 */
export function cacheDecision(opts: {
  stored: string | null | undefined;
  storedHash: string | null | undefined;
  currentText: string;
  force?: boolean;
}): { use: 'fresh' } | { use: 'cached'; payload: any; stale: boolean } {
  if (opts.force) return { use: 'fresh' };
  if (!opts.stored) return { use: 'fresh' };
  let payload: any = null;
  try {
    payload = JSON.parse(opts.stored);
  } catch {
    return { use: 'fresh' }; // a corrupt cache is no cache
  }
  if (!payload || typeof payload !== 'object') return { use: 'fresh' };
  // A reading that failed is not worth keeping him from a retry.
  if (payload.failed) return { use: 'fresh' };
  return { use: 'cached', payload, stale: storyFingerprint(opts.currentText) !== String(opts.storedHash || '') };
}
