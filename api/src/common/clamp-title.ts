/**
 * One way to shorten a generated title (BEA-1269).
 *
 * Titles that come out of a model have no length discipline, so every call site used to end with a
 * blunt `.slice(0, 160)`. A blunt slice lands wherever the 160th character happens to fall, which is
 * usually the middle of a word — the Home card read "…send it back to all three sa". Cutting at the
 * last whole word and marking the cut with an ellipsis is the difference between a shortened
 * sentence and a broken one.
 */

/** The ellipsis is part of the budget, so the result is never longer than `max`. */
const ELLIPSIS = '…';

/**
 * Trim `text` to at most `max` characters, cutting on a word boundary and marking the cut.
 *
 * Text already within the limit comes back untouched — no stray ellipsis on a title that fits.
 * When the first "word" is itself longer than the budget (a URL, a run-on token) there is no
 * boundary to cut on, so it falls back to a hard cut rather than returning just an ellipsis.
 *
 * `max` counts CHARACTERS, not UTF-16 code units: an emoji is one character, so a cut can never
 * land between the two halves of a surrogate pair and leave a broken glyph behind. Titles are
 * stored in SQLite `TEXT` columns, which have no length limit, so counting this way is safe.
 */
export function clampTitle(text: unknown, max = 160): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  if (chars.length <= max) return clean;

  const budget = max - ELLIPSIS.length;
  let head = chars.slice(0, budget).join('');

  // Only back up when the cut actually lands inside a word — a word followed by a comma or a full
  // stop is already whole, and backing up there would throw away a word we had room for.
  const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c || '');
  const lastOf = (s: string) => [...s].pop() || '';
  if (isWordChar(chars[budget]) && isWordChar(lastOf(head))) {
    const cut = head.lastIndexOf(' ');
    if (cut > 0) head = head.slice(0, cut);
  }

  // Trailing punctuation before the ellipsis reads as a typo ("date, …"), so strip it.
  const kept = head.replace(/[\s,;:.!?—–-]+$/, '');

  return kept ? kept + ELLIPSIS : chars.slice(0, max).join('');
}
