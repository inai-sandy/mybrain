/**
 * `@name` in a task — who else this touches. (BEA-1019)
 *
 * Two rules, and they are the whole point:
 *   1. Never guess. A name that matches two people is ambiguous and comes back for the owner to
 *      pick; a name that matches nobody comes back as unknown. We do NOT fuzzy-match typed text —
 *      the owner is looking at the keyboard, so a wrong link is worse than no link.
 *   2. Match the LONGEST known spelling. "@Vijaya Durga" is one person, not "Vijaya" plus stray
 *      text, and the only way to know that is to try the real contact spellings at that position.
 *
 * Pure functions — no database, no I/O — so every branch is testable.
 */

import { contactSpellings, norm, PersonContact } from '../contacts/person-identity';

export type MentionResolution =
  | { raw: string; status: 'matched'; contactId: string; contactName: string }
  | { raw: string; status: 'ambiguous'; options: { id: string; name: string }[] }
  | { raw: string; status: 'unknown' };

/** How many words a contact spelling may span — "Vijaya Durga" is 2; nobody sensible needs 5. */
const MAX_NAME_WORDS = 4;

/** Word characters we allow inside a name after "@": letters, digits, dots, apostrophes, hyphens. */
const NAME_CHAR = /[\p{L}\p{N}.'’-]/u;

/** Read one word starting at `i`; returns the word and the index just past it. */
function readWord(text: string, i: number): { word: string; next: number } {
  let j = i;
  while (j < text.length && NAME_CHAR.test(text[j])) j++;
  return { word: text.slice(i, j), next: j };
}

/**
 * Every `@mention` in the text, in order, de-duped case-insensitively.
 *
 * At each "@" we try the longest run of words that exactly matches a known contact spelling. If
 * nothing matches, we take the single following word so the caller can still report it as unknown
 * (that is how "@Rmesh" surfaces as a typo instead of vanishing).
 */
export function parseMentions(text: string, contacts: PersonContact[]): string[] {
  const src = String(text || '');
  if (!src.includes('@')) return [];

  const known = new Set<string>();
  for (const c of contacts) for (const s of contactSpellings(c)) known.add(norm(s));

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const t = raw.trim();
    if (!t || seen.has(norm(t))) return;
    seen.add(norm(t));
    out.push(t);
  };

  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '@') continue;
    // "a@b.com" is an email, not a mention.
    if (i > 0 && NAME_CHAR.test(src[i - 1])) continue;

    // Collect up to MAX_NAME_WORDS words after the "@", remembering where each run ended.
    const words: string[] = [];
    const ends: number[] = [];
    let cur = i + 1;
    while (words.length < MAX_NAME_WORDS) {
      const { word, next } = readWord(src, cur);
      if (!word) break;
      words.push(word);
      ends.push(next);
      if (src[next] !== ' ') break; // only a single space continues a name
      cur = next + 1;
    }
    if (!words.length) continue;

    // Longest known spelling wins.
    let taken = -1;
    for (let n = words.length; n >= 1; n--) {
      if (known.has(norm(words.slice(0, n).join(' ')))) { taken = n; break; }
    }
    if (taken > 0) {
      push(words.slice(0, taken).join(' '));
      i = ends[taken - 1] - 1;
    } else {
      push(words[0]); // unknown — reported, not silently dropped
      i = ends[0] - 1;
    }
  }
  return out;
}

/** Every contact whose name or alias is EXACTLY this name. No fuzzy — see the rules at the top. */
export function exactMatches<T extends PersonContact>(contacts: T[], name: string): T[] {
  const n = norm(name);
  if (!n) return [];
  return contacts.filter((c) => contactSpellings(c).some((s) => norm(s) === n));
}

/** Resolve one typed name to a contact, an ambiguity, or nothing. */
export function resolveName(contacts: PersonContact[], name: string): MentionResolution {
  const raw = String(name || '').trim();
  const hits = exactMatches(contacts, raw);
  if (hits.length === 1) return { raw, status: 'matched', contactId: hits[0].id, contactName: hits[0].name };
  if (hits.length > 1) return { raw, status: 'ambiguous', options: hits.map((c) => ({ id: c.id, name: c.name })) };
  return { raw, status: 'unknown' };
}

/** Resolve every `@mention` in a piece of text. */
export function resolveMentions(text: string, contacts: PersonContact[]): MentionResolution[] {
  return parseMentions(text, contacts).map((n) => resolveName(contacts, n));
}

/** Just the contact ids that resolved cleanly — what actually gets linked. */
export function linkableIds(resolutions: MentionResolution[]): string[] {
  const out: string[] = [];
  for (const r of resolutions) if (r.status === 'matched' && !out.includes(r.contactId)) out.push(r.contactId);
  return out;
}
