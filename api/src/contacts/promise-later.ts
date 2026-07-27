/**
 * "I'll send it at 12" is not "I sent it". (BEA-1152)
 *
 * On 27 July Rakesh ticked his share page at 05:42 — the app recorded today's report as received.
 * At 05:43:50 he messaged: "Update sheet sending 12 clock". He had not sent it. He was telling the
 * owner he would, an hour and a half later. But the tick came first, so the board said received and
 * the chase went quiet.
 *
 * So the rule is: whatever someone says LAST is what is true, and a promise about the future is
 * never an arrival. Getting this wrong the safe way costs one extra nudge. Getting it wrong the
 * other way loses the report entirely and the owner finds out at the end of the day.
 */

/** A time still to come: "at 12", "by 5pm", "in an hour", "tonight", "tomorrow". */
const FUTURE_WHEN = /\b(?:at|by|around|before|after)\s+\d{1,2}(?::\d{2})?\s*(?:o'?\s?clock|am|pm|clock)?|\b(?:tonight|tomorrow|later|shortly|soon|in (?:an?|\d+)\s+(?:hour|hours|min|mins|minute|minutes))\b/i;

/** Saying they are going to do it, rather than that they have. */
const WILL_SEND = /\b(?:will|i'?ll|we'?ll|gonna|going to)\s+(?:\w+\s+){0,2}(?:send|share|give|update|submit|mail|post|upload|do)\b|\b(?:sending|sharing|updating|submitting|uploading)\b/i;

/** Said outright in the past tense — believe them, whatever else is in the message. */
const ALREADY_SENT = /\b(?:sent|shared|submitted|uploaded|mailed|posted|attached|forwarded)\b|\b(?:done|completed)\b/i;

/**
 * Does this message promise the report for later rather than deliver it now?
 *
 * Deliberately conservative in one direction: a message that says they already sent it is never
 * read as a promise, even if it also mentions a time ("sent it at 11").
 */
export function promisesLater(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (ALREADY_SENT.test(t)) return false; // past tense wins — they say it is done
  if (WILL_SEND.test(t)) return true; // "sending", "will send"
  return WILL_SEND.test(t) && FUTURE_WHEN.test(t);
}

/**
 * Which of two signals stands. Equal timestamps keep what is already recorded, so a retry or a
 * duplicate webhook can never flip a settled day.
 */
export function laterWins(existingAt: Date | null | undefined, incomingAt: Date): boolean {
  if (!existingAt) return true;
  return incomingAt.getTime() > new Date(existingAt).getTime();
}
