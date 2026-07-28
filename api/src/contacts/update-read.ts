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
export type Read = 'done' | 'needs_you' | 'status' | 'promise' | 'chat';

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
  /\b(?:problem|issue|trouble|difficulty|shortage|short\s+of|out\s+of\s+stock|breakdown|damaged|defect|reject(?:ed|ion)?)\b/i,
  /\bneed\s+(?:your|sandeep|his|approval|permission|budget|payment|help|support|clarity|clarification)\b/i,
  /\bcan\s*n[o']?t\b|\bcannot\b|\bunable\b/i,
  /\bwho\s+(?:will|should)\b|\bshall\s+i\b|\bshould\s+(?:i|we)\b/i,
  /\?\s*$/, // they asked something
];

/** They are telling him a thing is finished. */
const CLAIMS_DONE = /\b(?:done|completed|finished|closed|delivered|dispatched|submitted|uploaded|sent\s+it|handed\s+over)\b/i;

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

  const trouble = TROUBLE.find((re) => re.test(t));
  if (trouble) {
    reads.add('needs_you');
    why = 'they raised a problem';
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
  } else if (CLAIMS_DONE.test(t) && !isQuantityNotClaim(t, reported)) {
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

/** Plain English for the review list — why this landed in front of him. */
export function readLabel(reads: Read[]): string {
  if (reads.includes('needs_you') && reads.includes('done')) return 'says it is done, and raised something';
  if (reads.includes('needs_you')) return 'raised a problem';
  if (reads.includes('done')) return 'says it is done';
  if (reads.includes('promise')) return 'promised it for later';
  if (reads.includes('status')) return 'sent an update';
  return 'said something';
}
