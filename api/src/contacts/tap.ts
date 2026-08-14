/**
 * Reading a tap. (BEA-1300)
 *
 * The chase nudge carries three quick-reply buttons — *Done* / *Still working on it* / *I'll reply
 * here*. Until now a tap arrived as the bare word "done" and a language model was left to work out
 * which of someone's three jobs it meant. That is the most consequential decision in the whole
 * delegation loop, and it was the one place a guess could silence a chase for work still open.
 *
 * Two facts now come with it (BEA-1299): the id of OUR message it answers, and the id of the button.
 *
 * **The button's PRESENCE is what matters, not its value.** The `reminder_nudge_v3` template was
 * created in Meta's console, not by this code, so nothing here knows what payloads it was given —
 * and a template edited later could change them without warning. So the meaning is read from the
 * label, which this codebase does control and does document, and the button id is used only as
 * proof that this was a tap rather than the same word typed inside a sentence.
 *
 * A tap that does not match anything known is NOT decisive. It falls through to the ordinary path
 * and is read like any other message. Guessing is the failure mode this exists to remove.
 */

export type TapMeaning = 'done' | 'working' | 'will-reply';

/** The exact labels on `reminder_nudge_v3`, and the obvious ways they get worded. */
const MEANINGS: { meaning: TapMeaning; match: RegExp }[] = [
  // "Still working on it" must be tested BEFORE "done": a label like "Not done yet" contains the
  // word and means the opposite. Order is the guard, so it is not an accident of listing.
  { meaning: 'working', match: /^(still\s+working(\s+on\s+it)?|working\s+on\s+it|in\s+progress|not\s+done(\s+yet)?)$/ },
  { meaning: 'will-reply', match: /^(i'?ll\s+reply(\s+here)?|reply\s+here|i'?ll\s+explain|let\s+me\s+explain)$/ },
  { meaning: 'done', match: /^(done|it'?s\s+done|completed|finished)$/ },
];

/**
 * What a tap means — or null if this was typed, or a tap we do not recognise.
 *
 * Returning null is a real answer, not a failure: it sends the message down the ordinary path where
 * the words are read properly, which is exactly right for anything we cannot be certain about.
 */
export function readTap(msg: { buttonId?: string | null; body?: string | null }): TapMeaning | null {
  if (!msg?.buttonId) return null; // typed, not tapped — nothing here applies
  const label = String(msg.body || '')
    .toLowerCase()
    // A curly apostrophe would make "I'll reply here" miss — Meta's console autocorrects, and the
    // label is typed there, not here. Falling through is safe, but silently losing a button we do
    // support is not the same as one we do not. (review finding)
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[.!·•\s]+/g, ' ')
    .trim();
  if (!label) return null;
  for (const { meaning, match } of MEANINGS) if (match.test(label)) return meaning;
  return null; // a button we do not know — read the words instead of inventing a meaning
}

/** Was this message a tap at all? Useful for telling a tap from typing in the stored thread. */
export function isTap(msg: { buttonId?: string | null }): boolean {
  return !!msg?.buttonId;
}
