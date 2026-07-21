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

/**
 * Which of the user's known people does this question mention? We match against real names from
 * their Contacts/people rather than guessing at capitalisation, because speech-to-text lowercases
 * names and invented "entities" would poison the search.
 */
export function findPeople(question: string, knownNames: string[]): string[] {
  const q = ` ${(question || '').toLowerCase()} `;
  const hits: string[] = [];
  for (const raw of knownNames) {
    const name = (raw || '').trim();
    if (name.length < 3) continue; // skip initials/noise
    const first = name.split(/\s+/)[0].toLowerCase();
    if (first.length < 3) continue;
    // word-boundary match on the first name (or the full name)
    const re = new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(q) && !hits.includes(name)) hits.push(name);
  }
  return hits.slice(0, 3);
}

/** The search text: the stripped question, with any named people kept prominent. */
export function buildSearchQuery(question: string, people: string[]): string {
  const core = stripMeta(question);
  if (!people.length) return core;
  const missing = people.filter((p) => !core.toLowerCase().includes(p.split(/\s+/)[0].toLowerCase()));
  return missing.length ? `${core} ${missing.join(' ')}`.trim() : core;
}
