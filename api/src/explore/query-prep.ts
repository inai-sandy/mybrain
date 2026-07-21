/**
 * Understand a spoken question BEFORE searching — with no LLM call (BEA-1011).
 *
 * The retrieval used to embed the question verbatim, so "How many times did I tell you I like
 * Preethi a lot?" went hunting for text resembling that whole sentence — including the useless
 * words "how many times". The saved memories say "dinner with Preethi", which doesn't resemble it,
 * so the search missed and the answer was "I couldn't find any statement…".
 *
 * Two cheap, instant steps fix that: strip the conversational wrapping, and pull out the people
 * being asked about so we can search for them directly too.
 */

import { PersonContact, matchContactsAll, contactSpellings, norm } from '../contacts/person-identity';

/** Conversational wrapping that is about ASKING, not about the content. Stripped before searching. */
const META = [
  /^\s*(hey|hi|ok|okay|so|and|also)\b[,\s]*/i,
  /^\s*how\s+(many\s+times|often)\s+(did|have)\s+i\s+(told|tell|said|say|mention(ed)?)\s*(you|u)?\s*/i,
  /^\s*how\s+(many\s+times|often)\s+(did|have)\s+i\s+/i,
  /^\s*(did|have)\s+i\s+(ever\s+)?(told|tell|said|say|mention(ed)?)\s*(you|u)?\s*(that\s+)?/i,
  /^\s*do\s+you\s+(remember|recall|know)\s*(if|whether|that|when)?\s*/i,
  /^\s*can\s+you\s+(tell|remind)\s+me\s*(about|if|whether)?\s*/i,
  /^\s*(what|when)\s+did\s+i\s+(say|tell\s+you)\s*(about)?\s*/i,
  /^\s*tell\s+me\s+about\s+/i,
  /^\s*(i\s+)?(want|need)\s+to\s+know\s*(about)?\s*/i,
];

/** Strip the asking-wrapper so what's left is the thing to actually look for. */
export function stripMeta(question: string): string {
  let q = (question || '').trim();
  // Apply repeatedly — real speech stacks these ("So, do you remember, did I ever say…").
  for (let i = 0; i < 4; i++) {
    const before = q;
    q = q.replace(/^[\s,;:-]+/, ''); // real speech leaves commas behind between stacked wrappers
    for (const re of META) q = q.replace(re, '').trim();
    if (q === before) break;
  }
  q = q.replace(/^[\s,;:-]+/, '');
  q = q.replace(/[?!.]+\s*$/, '').trim();
  return q || (question || '').trim();
}

/** Words that look like names but aren't — never treat these as a person. */
const NOT_A_NAME = new Set([
  'i', 'you', 'we', 'my', 'me', 'the', 'a', 'an', 'and', 'or', 'but', 'so', 'do', 'did', 'have', 'has',
  'what', 'when', 'where', 'who', 'why', 'how', 'is', 'was', 'are', 'were', 'about', 'with', 'for',
  'that', 'this', 'it', 'lot', 'like', 'told', 'tell', 'said', 'say', 'story', 'stories', 'time', 'times',
]);

/**
 * Which of the user's people is this question about — and EVERY spelling of them (BEA-1011).
 *
 * Real names are stored inconsistently ("Preeti" in 56 entries, "Preethi" in 16), so asking with one
 * spelling used to reach only part of that person's life. We match each word of the question against
 * the user's Contacts via the shared person-identity helpers, which expand aliases AND tolerate a
 * small spelling difference — then search EVERY spelling so both halves come back together.
 */
export function findPeople(question: string, contacts: PersonContact[]): string[] {
  const words = (question || '').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (w.length < 4 || NOT_A_NAME.has(w.toLowerCase())) continue;
    for (const c of matchContactsAll(contacts, w)) {
      for (const s of contactSpellings(c)) {
        if (!seen.has(norm(s))) { seen.add(norm(s)); out.push(s); }
      }
    }
  }
  return out.slice(0, 6); // a person + their spellings; a couple of people at most
}

/** The search text: the stripped question, with any named people kept prominent. */
export function buildSearchQuery(question: string, people: string[]): string {
  const core = stripMeta(question);
  if (!people.length) return core;
  const has = (p: string) => core.toLowerCase().includes(p.split(/\s+/)[0].toLowerCase());
  const missing = people.filter((p) => !has(p));
  return missing.length ? `${core} ${missing.join(' ')}`.trim() : core;
}
