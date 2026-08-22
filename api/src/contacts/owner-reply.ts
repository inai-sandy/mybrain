/**
 * The owner's own WhatsApp reply — how a question reaches him, and how his answer comes back
 * (BEA-1392, agent workers 7/10 — `specs/AGENT-WORKERS.md` §H).
 *
 * Everything here is a pure function plus one registry, on purpose:
 *
 *  - **Pure**, because the matching rules are the dangerous part. `postbox-callback.controller.ts`
 *    is a live road the owner depends on every day (Contacts, Reminders, the tap handler, the
 *    claims/daily-report loop). A rule that mis-reads one message could swallow a reply meant for a
 *    contact, so the rules are tested on their own, without a database.
 *  - **A registry** (the `setOwnerAlertTelegram` pattern in `owner-alert.ts`), because the answerer
 *    lives in `WorkerModule`, which already imports `ContactsModule` through `PushModule`. An import
 *    the other way would be a cycle; a registration at boot is not.
 *
 * **v1 is free text with numbered choices.** There is no `send_buttons` tool on the gateway, and
 * `send_list` is a free-form send that only reaches a recipient inside the 24-hour window — useless
 * for a question answered tomorrow. So a question numbers its choices ("reply 1, 2 or 3") and this
 * file reads `1` / `2` / `carry on` back. Tappable buttons need their own Meta-approved quick-reply
 * template with fixed labels, and are a separate later piece.
 */

/** What the callback controller hands the answerer, and what it gets back. */
export type OwnerReplyHandler = {
  /** Is this inbound `from` the owner's own number? Never throws — a false answer must be a plain no. */
  isOwnerNumber: (from: string) => Promise<boolean>;
  /** Answer the open question, if there is one. `answered:false` = nothing here was his, carry on. */
  onOwnerReply: (text: string, meta?: { wamid?: string | null }) => Promise<{ answered: boolean; waitpointId?: string }>;
};

let handler: OwnerReplyHandler | null = null;

/** Registered once at boot by `OwnerAskService`. `null` puts it back (the tests do). */
export function setOwnerReplyHandler(h: OwnerReplyHandler | null): void {
  handler = h;
}

/** The registered answerer, or null on a server where the worker road is not wired. */
export function ownerReplyHandler(): OwnerReplyHandler | null {
  return handler;
}

/** Just the digits — WhatsApp's `from` always carries the country code, a Setting may not. */
export function digitsOf(n: unknown): string {
  return String(n ?? '').replace(/[^\d]/g, '');
}

/**
 * Is this inbound number the owner's? The same two-step the Contact lookup has used since BEA-787:
 * an exact match, then the last 10 digits, so a number saved without its country code still matches.
 * Both sides must be real numbers — two empty strings are not "the owner".
 */
export function sameNumber(a: unknown, b: unknown): boolean {
  const x = digitsOf(a);
  const y = digitsOf(b);
  if (x.length < 10 || y.length < 10) return false;
  return x === y || x.slice(-10) === y.slice(-10);
}

/**
 * The short tag that rides on every question — `#a3f`, drawn from the waitpoint's own id.
 *
 * Only one question per run may be open at a time, but two RUNS can be waiting at once. A tagged
 * reply answers exactly the question it names; an untagged one answers the oldest (§H).
 */
export function askTag(waitpointId: unknown): string {
  const clean = String(waitpointId ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return clean ? `#${clean.slice(0, 3)}` : '';
}

/** The choices, numbered, as the owner reads them: `1 Carry on · 2 Stop`. */
export function numberedChoices(choices: string[] | undefined | null): string {
  const list = (choices || []).map((c) => String(c).trim()).filter(Boolean);
  if (!list.length) return '';
  return list.map((c, i) => `${i + 1} ${c}`).join(' · ');
}

/**
 * The question as one WhatsApp line. The template's variables cannot hold newlines (Meta refuses
 * them) — `flat()` in `owner-alert.ts` folds them, so the wording is built to read that way already.
 */
export function askDetail(question: string, choices?: string[] | null): string {
  const numbered = numberedChoices(choices);
  const how = numbered ? ` — reply ${(choices || []).map((_, i) => i + 1).join(', ')}: ${numbered}` : ' — reply with your answer';
  return `${String(question || '').trim()}${how}`;
}

/** One open question, as the matcher sees it. */
export type OpenAsk = { id: string; question: string; options?: string[]; createdAt?: Date | string | null };

/**
 * Which open question this reply answers.
 *
 * A reply that names a tag (`#a3f carry on`) answers that one — even when it is not the oldest, so a
 * late answer to yesterday's question can never be applied to today's. Otherwise the oldest wins.
 */
export function pickAsk(open: OpenAsk[], text: string): OpenAsk | null {
  const list = (open || []).filter(Boolean);
  if (!list.length) return null;
  const tag = (String(text || '').match(/#([a-z0-9]{2,8})\b/i) || [])[1];
  if (tag) {
    const found = list.find((w) => askTag(w.id) === `#${tag.toLowerCase()}`);
    if (found) return found;
  }
  return [...list].sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())[0];
}

/**
 * What the owner actually said, as an answer to THIS question.
 *
 * `1` picks the first choice, `2` the second; a word that starts one of the choices picks that one
 * ("carry" → "Carry on"). Anything else is passed through exactly as he wrote it — a question is
 * allowed to be answered in words, and inventing "he must have meant option 1" is how a run does
 * the wrong thing. The tag, when he kept it, is stripped: it is addressing, not an answer.
 */
export function readOwnerAnswer(text: string, choices?: string[] | null): { answer: string; matched: 'number' | 'word' | 'free' } {
  const raw = String(text || '').replace(/#[a-z0-9]{2,8}\b/i, ' ').replace(/\s+/g, ' ').trim();
  const list = (choices || []).map((c) => String(c).trim()).filter(Boolean);
  if (list.length) {
    const n = raw.match(/^(?:option\s*)?([1-9])\b[.)]?/i);
    if (n) {
      const i = Number(n[1]) - 1;
      if (i >= 0 && i < list.length) return { answer: list[i], matched: 'number' };
    }
    const low = raw.toLowerCase();
    const word = list.find((c) => c.toLowerCase() === low) || list.find((c) => low.length >= 3 && (c.toLowerCase().startsWith(low) || low.startsWith(c.toLowerCase())));
    if (word) return { answer: word, matched: 'word' };
  }
  return { answer: raw, matched: 'free' };
}
