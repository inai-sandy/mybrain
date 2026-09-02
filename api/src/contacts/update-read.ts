import { promisesLater } from './promise-later';

/**
 * What a message from the team actually means. (BEA-1159)
 *
 * The owner's spec:
 *
 *   "When they reply, if the reply requires my help, definitely it has to be in review."
 *   "They will not say 'I need Sandeep's help.' They will say 'I am facing a problem, I haven't
 *    received whatever it is.' When they say this, it has to land in my review section."
 *
 * That second line is the whole difficulty. The app already asked the model `needsSandeep`, but the
 * prompt defined it as *"if they ASK something you don't know"* — so on 27 July Radha wrote
 *
 *   "1. We didn't receive sense PCB for 4M — 4 Switch 1Socket
 *    2. ESP Add on PCB for magnetic touch was pending"
 *
 * and both her reminders stayed `needsOwner: false`. She never asked. She stated a problem, and it
 * sailed past into a green tick.
 *
 * So the reading is done here, deterministically, on the words themselves. The AI may propose; this
 * decides. Getting it wrong by showing him one extra message costs a glance. Getting it wrong the
 * other way leaves a production line stopped and nobody knowing.
 */

/** A message can mean several things at once — Radha's is a real report AND two blockers. */
export type Read = 'done' | 'needs_you' | 'status' | 'promise' | 'chat' | NeedKind;

/**
 * WHAT they need him for — the finer kinds that sit beside `needs_you` in a row's reads, so the
 * inbox can say "asked for money" instead of the one-size "raised a problem". (BEA-1597)
 *
 *   money     — they asked for a payment, an advance, a budget
 *   decision  — a yes/no or a pick is waiting on him
 *   question  — they asked him something, with or without a "?"
 *   blocked   — stuck, missing, late, waiting on somebody
 *   no_reply  — the app's own watchdog row: their reply went unanswered (channel `system`)
 *
 * `needs_you` stays the umbrella every filter reads; a kind never appears without it.
 */
export type NeedKind = 'money' | 'question' | 'decision' | 'blocked' | 'no_reply';
export const NEED_KINDS: readonly NeedKind[] = ['money', 'decision', 'question', 'blocked', 'no_reply'];
export function isNeedKind(x: unknown): x is NeedKind {
  return typeof x === 'string' && (NEED_KINDS as readonly string[]).includes(x);
}

/**
 * Something is stuck, missing, late, or waiting on somebody. Drawn from how the owner's team
 * actually writes — short, plain, often no punctuation.
 */
const TROUBLE = [
  /\b(?:did\s*n[o']?t|didnt|have\s*n[o']?t|havent|has\s*n[o']?t|hasnt|not)\s+(?:yet\s+)?(?:receiv|get|got|arriv|complet|finish|start)/i,
  /\bnot\s+(?:able|possible|working|done|ready|available|clear)\b/i,
  /\b(?:still\s+)?pending\b/i,
  /\bwaiting\s+(?:for|on)\b/i,
  /\b(?:is|are|got|getting)\s+(?:stuck|blocked|delayed|held\s*up)\b/i,
  // "problem"/"issue" only when it reports trouble, not when it names a thing. Jayanth's nightly OT
  // report lists "Trinetra Problem Devices For Rework" — a device category. Flagging that would put
  // a routine report in front of him every night, and an inbox with noise in it stops being read.
  // No /i flag on purpose: the word must be case-insensitive but the lookahead must NOT be, or
  // [A-Z] would match any letter and every "problem" would be excluded.
  /\b(?:[Pp]roblem|[Ii]ssue|[Tt]rouble)s?\b(?!\s+[A-Z])/,
  /\b(?:difficulty|shortage|short\s+of|out\s+of\s+stock|breakdown|damaged|defect|reject(?:ed|ion)?)\b/i,
  /\bneed\s+(?:help|support)\b/i,
  /\bcan\s*n[o']?t\b|\bcannot\b|\bunable\b/i,
];

/**
 * They want a yes, a no, or a pick from him. (BEA-1597)
 * "Shall I go ahead", "pls confirm the qty", "which one", "need your approval".
 */
const DECISION = [
  /\bwho\s+(?:will|should)\b|\bshall\s+(?:i|we)\b|\bshould\s+(?:i|we)\b|\bcan\s+we\b/i,
  /\b(?:pls|plz|please|kindly)\s+confirm\b|\bconfirm\s+(?:pls|plz|please|sir)\b/i,
  /\bneed\s+(?:your|ur|sandeep'?s?|his)\s+(?:approval|permission|go[- ]ahead|ok|okay|decision|confirmation)\b|\b(?:your|ur)\s+approval\b/i,
  /\bwhich\s+one\b|\bis\s+it\s+ok(?:ay)?\b/i,
];

/** Money: a payment, an advance, a budget — asked for, not merely reported. (BEA-1597) */
const MONEY_WORD = /₹|\$\s*\d|\b(?:rs\.?|inr|usd)\s*\d|\d\s*(?:rs|rupees|usd|dollars|lakhs?)\b|\b(?:payment|money|advance|budget|funds?|cash)\b/i;
const MONEY_ASK = /\b(?:need|needs|needed|require|required|release|transfer|arrange|approve|approval|pay|pending|due|send|sanction)\b/i;

/**
 * They asked him something WITHOUT a question mark — how his team actually writes.
 * "sir what is the budget for the Elleys order", "let me know", "pls check". (BEA-1597)
 */
const ASKS = [
  /\b(?:let\s+me\s+know|can\s+(?:you|u)|could\s+(?:you|u)|kindly\s+advise|please\s+advise|waiting\s+for\s+(?:your|ur)|need\s+(?:your|ur)|what\s+(?:is|are|about|should|to\s+do)|how\s+much|how\s+many|when\s+(?:can|will|should)|where\s+(?:is|are))\b/i,
  /\b(?:pls|plz|please)\s+(?:check|tell|share|send|reply|update|suggest|advise|clarify|guide|look)\b/i,
  /\bneed\s+(?:clarity|clarification)\b/i, // was in the old trouble list — kept
];

/**
 * A request that names the owner: "Sandeep sir, we need the drawing", "sir pls send it". The name
 * and the asking word must sit CLOSE — "As discussed with Sandeep, will update tomorrow" names him
 * and asks nothing, and a routine line must never flip on his name alone. (review finding)
 */
const REQUEST = '(?:pls|plz|please|kindly|send|share|give|check|confirm|approve|tell|need|want|call|suggest|advise|help|reply)';
const OWNER_ASK = new RegExp(`\\bsandeep\\b[^\\n]{0,30}?\\b${REQUEST}\\b|\\b${REQUEST}\\b[^\\n]{0,30}?\\bsandeep\\b`, 'i');
const SIR_PLEASE = /\bsir\b[^\n]{0,24}?\b(?:pls|plz|please|kindly)\b|\b(?:pls|plz|please|kindly)\b[^\n]{0,24}?\bsir\b/i;

/**
 * A "?" anywhere, judged per LINE, on a line with at least two real words. (BEA-1597)
 *
 * The old rule was `/\?\s*$/` — a "?" at the very end of the whole message — so a question on the
 * first line of a two-line message never counted. Two words on the line keeps a "?" inside a
 * product code or a link from reading as a question; the "?" must also end a word, not sit inside
 * one ("SPD-3?0" is a code).
 */
function asksWithMark(text: string): boolean {
  const lines = text.replace(/https?:\/\/\S+/gi, ' ').split(/\r?\n/);
  return lines.some((line) => /\?(?!\w)/.test(line) && (line.match(/[A-Za-z]{2,}/g) || []).length >= 2);
}

/** Every finer kind the words carry — what, exactly, they need him for. Empty = nothing needs him. */
export function needKindsOf(text: string): NeedKind[] {
  const t = String(text || '').trim();
  const kinds: NeedKind[] = [];
  if (MONEY_WORD.test(t) && MONEY_ASK.test(t)) kinds.push('money');
  if (DECISION.some((re) => re.test(t))) kinds.push('decision');
  if (asksWithMark(t) || ASKS.some((re) => re.test(t)) || OWNER_ASK.test(t) || SIR_PLEASE.test(t)) kinds.push('question');
  if (TROUBLE.some((re) => re.test(t))) kinds.push('blocked');
  return kinds;
}

/** They are telling him a thing is finished. */
const CLAIMS_DONE = /\b(?:done|completed|finished|closed|delivered|dispatched|submitted|uploaded|sent\s+it|handed\s+over)\b/i;

/** Words that plainly mean the whole thing is finished — these beat any progress signal. */
const CLEARLY_COMPLETE =
  /\b(all done|fully (done|completed|uploaded|sent)|100\s*%|completed all|finished all|everything (is )?(done|completed|uploaded|sent)|it is (completed|complete|done)|its? (completed|complete|done))\b/i;

/** "so far" / "up to now" / "remaining" / "working on it" — a report of progress, not of completion. */
const PROGRESS_WORDS =
  /\b(so far|till now|till date|up\s?to\s?(now|know|date)|as of now|in progress|work(ing)? on it|almost|partially|partial|remaining|balance|pending|yet to|not yet|will (finish|complete|do)|started|ongoing)\b/i;

/** "45 of 120", "45 out of 120", "45/120" — short of the total. */
function shortOfTotal(text: string): boolean {
  const re = /(\d[\d,]*)\s*(?:\/|of|out of)\s*(\d[\d,]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const a = Number(m[1].replace(/,/g, ''));
    const b = Number(m[2].replace(/,/g, ''));
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0 && a < b) return true;
  }
  return false;
}

/**
 * Does this message read as PROGRESS rather than completion? (BEA-1122)
 *
 * The prompt already tells the model that a partial update is not finished, and it still read
 * "Total we have 120 BOMs to upload, upto know we uploaded 45 BOMs" as done — which filed a claim,
 * silenced the chase, and left the person un-chased for two days. Wording alone was not enough, so
 * this is a deterministic second opinion: when a message plainly reports progress, a "done" from
 * the model is refused. Erring this way only costs an extra nudge; erring the other way loses the
 * chase entirely.
 *
 * Moved here from the agent (BEA-1211): the review queue reads with readUpdate below, which was
 * built WITHOUT this guard — so "started, working on it" landed in review as a done-claim, the
 * exact bug BEA-1122 had already fixed on the claims path. One home, one opinion.
 */
export function looksLikePartialProgress(text: string): boolean {
  const t = String(text || '').trim();
  if (!t) return false;
  if (CLEARLY_COMPLETE.test(t)) return false; // they said it outright — believe them
  if (shortOfTotal(t)) return true;
  if (PROGRESS_WORDS.test(t)) return true;
  // Present continuous with no completion word: "we are using it and updating the data" is an
  // ongoing state, not a finished job.
  if (/\b(is|are|am)\s+\w+ing\b/i.test(t)) return true;
  return false;
}

/** Real content — figures, quantities, names of things. A status report rather than an ack. */
const HAS_SUBSTANCE = /\d/;

/** Nothing to act on: an acknowledgement and no more. */
const ACK_ONLY = /^(?:ok(?:ay)?|kk?|k|yes|yeah|sure|noted|thanks?|thank\s*you|got\s*it|fine|good|welcome|sir|ji|\p{Emoji}|\s|[.!,])+$/iu;

export type ReadResult = { reads: Read[]; needsYou: boolean; why: string | null };

/**
 * Read one message. `isReport` says whether this contact owes a standing report the message could
 * be satisfying — a status read only makes sense when something was actually owed.
 */
export function readUpdate(text: string, opts: { isReport?: boolean } = {}): ReadResult {
  const t = String(text || '').trim();
  if (!t) return { reads: [], needsYou: false, why: null };

  // "Kk sir" is not a report, not a claim, and must never clear anything.
  if (ACK_ONLY.test(t)) return { reads: ['chat'], needsYou: false, why: null };

  const reads = new Set<Read>();
  let why: string | null = null;

  const kinds = needKindsOf(t);
  if (kinds.length) {
    reads.add('needs_you');
    for (const k of kinds) reads.add(k);
    why = WHY[kinds[0]];
  }

  // Substance means they genuinely reported. This is INDEPENDENT of trouble: Radha's message is a
  // real evening report AND two blockers. Forcing one or the other is what turned it into a tick.
  const isPromise = promisesLater(t);
  const reported = !!opts.isReport && !isPromise && (HAS_SUBSTANCE.test(t) || t.length >= 40);
  if (reported) reads.add('status');

  // A promise is never an arrival — checked before "done", because "will send it, done by 5" is a
  // promise. (BEA-1152)
  if (isPromise) {
    reads.add('promise');
  } else if (CLAIMS_DONE.test(t) && !isQuantityNotClaim(t, reported) && !looksLikePartialProgress(t)) {
    // The progress guard runs here too (BEA-1211): "started the upload" contains a done-word but
    // reads as progress, and a progress report must never demand a yes/no in review.
    reads.add('done');
    if (!why) why = 'they say it is finished';
  }

  if (!reads.size) reads.add('chat');
  return { reads: [...reads], needsYou: reads.has('needs_you') || reads.has('done'), why };
}

/**
 * "2000 completed" in a production report is a QUANTITY, not a claim that the job is finished.
 *
 * A judgement call, and the reason for it: in a long substantive report a completion word almost
 * always belongs to a figure — "2000 PCB completed", "45 BOMs uploaded". Reading that as "Radha
 * says it is done" would put a routine evening report in front of him for a yes/no every day, and
 * the review list only works if everything in it genuinely needs him. A short message is different:
 * "It is completed" is exactly the claim it looks like.
 */
function isQuantityNotClaim(text: string, reported: boolean): boolean {
  // Short is the signal that the word is about the whole thing: "Done", "It is completed", "All done".
  // Anything longer inside a report is describing work — "In Production: 2000 PCB completed."
  return reported && text.trim().length > 25;
}

/** The reason line's first half, per kind — in the order `needKindsOf` lists them, most specific first. */
const WHY: Record<NeedKind, string> = {
  money: 'they asked for money',
  decision: 'they need your decision',
  question: 'they asked you a question',
  blocked: 'they raised a problem',
  no_reply: 'their reply went unanswered',
};

/**
 * The ONE kind → wording map (BEA-1597). Every surface that says WHY an item needs him — Tasks →
 * Needs you, the Dashboard's team rows, a person's story — reads this and nothing else. Short,
 * plain, and the same string everywhere, so a spec can assert both screens agree.
 */
const LABEL: Record<NeedKind, string> = {
  money: 'asked for money',
  decision: 'needs your decision',
  question: 'asked you a question',
  blocked: 'stuck / blocked',
  no_reply: 'waiting on your reply',
};
const DONE_LABEL = 'claims done — needs your check';

/** Plain English for the review list — why this landed in front of him. */
export function readLabel(reads: Read[]): string {
  const done = reads.includes('done');
  if (reads.includes('needs_you')) {
    // Most specific first: money beats a question beats "stuck" when one message is all three.
    const kind = NEED_KINDS.find((k) => reads.includes(k));
    // A row flagged before the finer kinds existed, or raised by the AI with no kind named.
    const need = kind ? LABEL[kind] : 'needs your attention';
    return done ? `${need}, and claims done` : need;
  }
  if (done) return DONE_LABEL;
  if (reads.includes('promise')) return 'promised it for later';
  if (reads.includes('status')) return 'sent an update';
  return 'said something';
}
