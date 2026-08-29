/**
 * Every failure a customer sees ends in one of his six moves (BEA-1580).
 *
 * The owner, on shipping: *"he tried creating an agent, and it failed. How can he fix it?"* A
 * customer who cannot code has exactly six moves:
 *
 *   read a reason · Run again / Rebuild · say it differently in chat · "run it the old way" ·
 *   connect a tool in /tools · wait
 *
 * So the rule is: WHEN a failure is customer-actionable, its message ends in one of those six,
 * named plainly. And WHEN it is plumbing-class — OUR infrastructure, not his ask — it is never
 * presented as his problem at all: *"the worker runner could not be reached"*, *"no readable
 * meta.json"*, *"NOT_REPEATABLE"* mean nothing to him. He sees the calm shape ("something on our
 * side hiccupped…") while the honest internal sentence stays STORED on the run/build row for us —
 * classification happens where a message is SHOWN or CREATED, never by rewriting history rows.
 *
 * This is the ONE classifier (the BEA-1544 pattern: a rule two call sites need lives in one file).
 * It is pure and dumb on purpose — string in, verdict out, no imports — so BEA-1581 (the alert to
 * us when a plumbing class fires) can call it from anywhere without imports going backwards.
 *
 * MUST NOT soften honesty: a real failure still says what happened; this file only adds the NEXT
 * STEP, or takes the blame where the blame is ours.
 */

/** The customer's six moves. `read-reason` means the message is complete as it stands. */
export type SixMove = 'read-reason' | 'run-again' | 'say-differently' | 'old-way' | 'connect-tool' | 'wait';

/**
 * A plumbing class: a failure of OUR infrastructure. These are DATA on purpose — BEA-1581 alerts
 * on exactly these ids, so add a class here and the alert learns it for free.
 */
export type PlumbingClass = {
  /** Stable id. BEA-1581 keys its alerts on this — renaming one silently un-alerts it. */
  id: string;
  /** What it means, for us. Never shown to the customer. */
  means: string;
  /** Matches the honest internal sentence wherever it was written. */
  test: RegExp;
  /** A calm line of its own, when the generic one would mislead (the AI-blank case). */
  calm?: string;
};

export const PLUMBING_CLASSES: PlumbingClass[] = [
  {
    id: 'runner-unreachable',
    means: 'the worker runner (the host service on :8769) was down or did not answer',
    test: /worker runner could not be reached|worker runner did not answer/i,
  },
  {
    id: 'runner-root-unusable',
    means: 'the runner cannot read or write its workers folder (WORKER_ROOT)',
    test: /cannot use its workers folder/i,
  },
  {
    id: 'worker-install-broken',
    means: 'the installed worker folder is unreadable — meta.json, kit versions or worker.mjs',
    test: /no readable meta\.json|kit version is unknown|could not read the kit versions|has no worker\.mjs/i,
  },
  {
    id: 'kit-mismatch',
    means: 'the worker was built for a newer kit than the app runs (an app rollback met a newer worker)',
    test: /built for kit v\d+/i,
  },
  {
    id: 'not-repeatable',
    means: "a resumed worker diverged from its own journal (the NOT_REPEATABLE guard)",
    test: /NOT_REPEATABLE|worker is not repeatable/i,
  },
  {
    id: 'worker-crash',
    means: 'the worker process died without a reason of its own',
    test: /worker stopped without saying why|worker exited with code \d+/i,
  },
  {
    id: 'app-restart',
    means: 'the app was restarted or deployed while the worker was still going',
    test: /app stopped listening/i,
  },
  {
    id: 'model-blank',
    means: 'an AI helper answered nothing or was unreachable (a transient provider blank, not his ask)',
    // "the worker-think model returned nothing", "the shaping model could not be reached — …".
    // The word "model" is load-bearing: BEA-1575's "The AI could not be reached just now — …day's
    // AI budget…" is the customer's own wait-move message and must NOT land here.
    test: /\bmodel (returned nothing|could not be reached)/i,
    calm: 'The AI could not be reached just now — nothing was lost; it will work on the next run. It has been noted.',
  },
];

/** Which plumbing class this failure belongs to, or null = customer-actionable. */
export function plumbingClassOf(error: unknown): string | null {
  const s = String(error ?? '');
  if (!s.trim()) return null;
  for (const c of PLUMBING_CLASSES) if (c.test.test(s)) return c.id;
  return null;
}

/**
 * The calm customer shape for a plumbing failure. The honest internal sentence is NOT in it — it
 * stays stored on the run/build row, where we read it (and where BEA-1581 will alert on it).
 */
export function plumbingWords(opts: { classId?: string | null; ranOldWay?: boolean } = {}): string {
  const own = opts.classId ? PLUMBING_CLASSES.find((c) => c.id === opts.classId)?.calm : undefined;
  if (own) return own;
  if (opts.ranOldWay) return 'Something on our side hiccupped — your agent ran the old way instead, so nothing was lost. It has been noted.';
  return 'Something on our side hiccupped — this was not caused by anything in your agent, and nothing half-done was left behind. It has been noted; run it again when you like.';
}

/**
 * Which of the six moves a customer-actionable failure should end in. Heuristics over the words the
 * app already writes — a connect-me failure names /tools, a vendor timeout is a wait, and anything
 * else is honestly "run it again" (the re-run button is on every failed run).
 */
export function moveOf(error: unknown): SixMove {
  const s = String(error ?? '');
  if (namesConnect(s)) return 'connect-tool';
  if (/say it (differently|another way)|saying it another way|rephrase/i.test(s)) return 'say-differently';
  if (/the old way/i.test(s)) return 'old-way';
  if (/timed? ?out|too long|rate.?limit|\b429\b|ETIMEDOUT|ECONN|fetch failed|unreachable|could not be reached|try again later|busy right now/i.test(s)) return 'wait';
  return 'run-again';
}

/**
 * Does this text tell him to CONNECT something — as an instruction, never as jargon?
 *
 * Node writes its own transport failures as literally `connect ECONNREFUSED 1.2.3.4:443`, and every
 * HTTP provider's error can carry that (`describeTransportError` in tools/transport.ts). Matching a
 * bare "connect" sent a customer to /tools over a network blip — so the word only counts followed by
 * `it/them/your` or a real service name (capital + lowercase, which an all-caps errno never has).
 */
function namesConnect(s: string): boolean {
  return /\/tools\b|not-connected/i.test(s) || /\bconnect (it|them|your)\b/i.test(s) || /\b[Cc]onnect(?:ing)? [A-Z][a-z]/.test(s);
}

/**
 * Does this message already end in a move, named plainly? Judged on the tail — a move mentioned in
 * passing at the top is not a next step. A named door ("in Settings", "paste its link…") counts:
 * the six moves are about the customer knowing what to DO, not about a fixed form of words.
 */
export function endsInMove(text: string): boolean {
  const tail = String(text ?? '').trim().slice(-160);
  // Phrase FORMS, never bare technical words: "connect" alone matches Node's own
  // `connect ECONNREFUSED …` transport jargon, "later"/"wait" alone match anything — and a short
  // message sits entirely inside this window, so a stray word would wrongly count as compliant.
  if (namesConnect(tail)) return true;
  return [
    /\brun\b[^.!?]{0,24}\bagain\b/i,
    /try (it |that )?again/i,
    /on the next run/i,
    /\brebuild (it|its|the|one)\b/i,
    /press rebuild/i,
    /\bbuild one\b/i,
    /say(ing)? it (differently|another way)/i,
    /\bsay it\b.*\btry again\b/i,
    /the old way/i,
    /in (the job'?s )?Settings/i,
    /Settings\s*→/,
    /when you like/i,
    /in an hour/i,
    /try again later/i,
    /answer (it|the question)/i,
  ].some((re) => re.test(tail));
}

/** The plainly-named closing for each move. `read-reason` appends nothing — the reason IS the move. */
const CLOSING: Record<SixMove, string> = {
  'read-reason': '',
  'run-again': 'Run it again when you like.',
  'say-differently': "Say it differently in the chat and I'll try again.",
  'old-way': 'Run it the old way — switch its worker off in Settings → Worker.',
  'connect-tool': 'Open /tools and connect it, then run it again.',
  wait: 'Try again in an hour.',
};

/** A rebuild-flavoured closing for the one family where "run it again" would hit the same wall. */
const NEEDS_A_BUILD_RE = /no worker is installed|no worker yet|worker.*out of date|no source called/i;

/**
 * The one entry point: what the CUSTOMER reads for this failure.
 *
 *  - plumbing-class → the calm shape (never his problem; the honest sentence stays on the row);
 *  - already ends in a move → returned untouched (BEA-1575's chatEdit reasons, the stall watchdog,
 *    "Connect Google Sheets first — open /tools…" all pass through unchanged);
 *  - otherwise → the same honest sentence with its move appended, named plainly.
 */
export function customerWords(error: unknown, opts: { ranOldWay?: boolean } = {}): string {
  const s = String(error ?? '').trim();
  if (!s) return plumbingWords(opts); // a failure with no reason at all is ours, never his
  const classId = plumbingClassOf(s);
  if (classId) return plumbingWords({ classId, ranOldWay: opts.ranOldWay });
  if (endsInMove(s)) return s;
  if (NEEDS_A_BUILD_RE.test(s)) return join(s, 'Rebuild its worker in Settings → Worker, then run it again.');
  return join(s, CLOSING[moveOf(s)]);
}

/** "<reason>. <Move.>" — one space, and never a bare full stop glued onto one already there. */
function join(reason: string, closing: string): string {
  if (!closing) return reason;
  const r = reason.replace(/\s+$/, '');
  return /[.!?…)]$/.test(r) ? `${r} ${closing}` : `${r}. ${closing}`;
}

/**
 * BEA-1575's chatEdit reasons, absorbed as DATA — not re-worded (its own test pins these sentences
 * in `hermes-bridge.service.ts` by reading the source, so the sentences stay written there and this
 * copy is locked against that source by `failure-words.spec.ts`: re-word either and a test says so).
 * Each already ends in its move: say it differently · read the reason (a named door) · wait.
 */
export const CHAT_EDIT_WORDS = {
  didNotUnderstand: "I couldn't work that one out — try saying it another way.",
  promptMissing: 'Editing by chat is switched off — its prompt is missing in Settings → Prompts.',
  budget: "The AI could not be reached just now — usually the day's AI budget is used up. Nothing was changed; try again later.",
  unreadableReply: "The AI answered, but not in a form I could read. Nothing was changed — say it another way and I'll try again.",
} as const;
