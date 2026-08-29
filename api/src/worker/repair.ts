import { createHash } from 'crypto';
import { SANDBOX_RULE, TRIAL_RULE } from './brief-rules';
import { WorkerContract, contractInWords } from './contract';

/**
 * Self-heal, the pure half (BEA-1393, agent workers 8/10 — `specs/AGENT-WORKERS.md` §G).
 *
 * The owner's own reason for this whole architecture: *"If a micro-service fails, Codex will
 * re-stitch the changes that are required."* That has to be a mechanism, not a hope, so everything
 * that decides ANYTHING about a repair is a pure function here, with a test on it:
 *
 *  - **what broke** (`causeOf`) — the same break must never re-enter the loop, and a different one
 *    must. So a failure is named: the contract rule it broke and the action it broke on;
 *  - **whether the repair changed the answer** (`driftOf`) — the promotion guard. Self-healing may
 *    fix plumbing; it may not quietly change what the owner's agent returns;
 *  - **what the owner is told** (`stopWords`, `fixedWords`, `heldWords`) — plain sentences, and the
 *    same ones the tests assert, so a change of words is a change anybody can see.
 */

/** The owner's decision, 2026-08-22: **two** attempts per failure cause, not three. */
export const MAX_ATTEMPTS = 2;

/**
 * How much the rows may move before a repair is held for the owner instead of promoted.
 *
 * A tenth of the rows, and not one column. The reasoning: a genuine plumbing fix (a field that moved,
 * a de-dupe that was one row out) touches a handful of rows and keeps every column; anything wider is
 * a different answer, and a different answer is the owner's decision, not the loop's. Column changes
 * are never inside the tolerance at all — a column is what he reads.
 */
export const PARITY_TOLERANCE = 0.1;

/** The contract rules a failure can break, and the other ways a worker can die. */
export type FailureRule =
  | 'unrecognised'
  | 'norows'
  | 'nofetch'
  | 'empty'
  | 'minRows'
  | 'maxRows'
  | 'columns'
  | 'mustHave'
  | 'freshness'
  | 'uncheckedWrite'
  | 'notRepeatable'
  | 'stopped'
  | 'stalled'
  | 'crash';

/** What one source answered, as the run journal recorded it — the evidence a repair reads. */
export type FetchEvidence = {
  sourceId: string;
  actionId: string;
  label?: string | null;
  args?: Record<string, any>;
  empty?: boolean;
  unrecognised?: boolean;
  why?: string | null;
  stop?: string | null;
  rows?: number;
  columns?: string[];
  /** Exactly what `POST /api/worker/tool` answered — what the worker itself saw. */
  answer?: any;
};

export type FailureCause = {
  rule: FailureRule;
  /** The action the failure happened on, when one can be named. '' = the job as a whole. */
  actionId: string;
  /** `jobId|rule|actionId` — the key the two attempts are counted against. */
  key: string;
  /** The rule in the owner's words, for the notice and the build row. */
  label: string;
};

/** Every sentence `checkContract()` can fail with, mapped to the rule that wrote it. */
const RULES: { re: RegExp; rule: FailureRule }[] = [
  { re: /not an empty day at the vendor, it is a bug here/i, rule: 'unrecognised' },
  { re: /recognised 0 rows/i, rule: 'norows' },
  { re: /nothing was fetched at all/i, rule: 'nofetch' },
  { re: /finding nothing is never all right/i, rule: 'empty' },
  { re: /needs at least \d+/i, rule: 'minRows' },
  { re: /is more than the [\d,]+ this job should ever produce/i, rule: 'maxRows' },
  { re: /missing the columns?/i, rule: 'columns' },
  { re: /(have no .+ column at all|that column is empty in most rows)/i, rule: 'mustHave' },
  { re: /older than the last \d+ days/i, rule: 'freshness' },
  { re: /(call kit\.expect|not the rows kit\.expect\(\) checked)/i, rule: 'uncheckedWrite' },
  { re: /not repeatable/i, rule: 'notRepeatable' },
  { re: /stopped making progress/i, rule: 'stalled' },
];

/** A rule in the owner's words. One place, so the notice, the brief and the row always agree. */
export function ruleWords(rule: string): string {
  return RULE_WORDS[rule as FailureRule] || 'it failed';
}

const RULE_WORDS: Record<FailureRule, string> = {
  unrecognised: 'the answer carried data but no rows were recognised',
  norows: 'the sources answered but no rows came out of them',
  nofetch: 'nothing was fetched at all',
  empty: 'every source came back empty',
  minRows: 'too few rows',
  maxRows: 'far too many rows',
  columns: 'a column the job asks for was missing',
  mustHave: 'a column came back blank in most rows',
  freshness: 'every row was older than the window',
  uncheckedWrite: 'it tried to write rows it had not checked',
  notRepeatable: 'it did not take the same road on a replay',
  stopped: 'a call was refused',
  stalled: 'it stopped making progress',
  crash: 'it crashed',
};

/**
 * What broke, named. The rule comes from the failure's own sentence — those sentences are written by
 * `checkContract()` in the kit, which is ours, and `repair.spec.ts` drives that function to prove the
 * two stay in step.
 *
 * A crash carries a signature of its message (letters only, first 80 characters), so two different
 * crashes are two different causes and each gets its own two attempts — while the SAME crash, after
 * two failed repairs, never re-enters the loop.
 */
export function causeOf(input: { jobId: string; error: string; fetches?: FetchEvidence[] }): FailureCause {
  const error = String(input.error || '');
  const fetches = input.fetches || [];
  let rule: FailureRule = 'crash';
  for (const r of RULES) {
    if (r.re.test(error)) { rule = r.rule; break; }
  }
  if (rule === 'crash' && fetches.some((f) => f.stop)) rule = 'stopped';

  const broken = fetches.find((f) => f.unrecognised) || fetches.find((f) => f.stop) || (fetches.length === 1 ? fetches[0] : undefined);
  const actionId = rule === 'unrecognised' || rule === 'stopped' || fetches.length === 1 ? String(broken?.actionId || '') : '';
  const sig = rule === 'crash' ? `:${signature(error)}` : '';
  return { rule, actionId, key: `${input.jobId}|${rule}${sig}|${actionId}`, label: RULE_WORDS[rule] };
}

/** A crash message with everything changeable taken out — numbers, ids, quotes, paths. */
export function signature(error: string): string {
  const flat = String(error || '')
    .toLowerCase()
    .replace(/[0-9]+/g, '#')
    .replace(/["'`].*?["'`]/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return createHash('sha256').update(flat).digest('hex').slice(0, 8);
}

// ---- the promotion guard -----------------------------------------------------------------------

/** What one version produced when it was run against the saved answers, and nothing else. */
export type ParityResult = {
  ok: boolean;
  error?: string | null;
  rows?: number;
  columns?: string[];
  /** One short hash per row, so two runs can be compared without carrying the rows around. */
  rowKeys?: string[];
  /** The routes the worker called, in order — a repair that changes the call order is worth seeing. */
  calls?: string[];
};

export type Drift = {
  /** True when the repair may be promoted without asking: the rows are the same answer. */
  within: boolean;
  /** 0 = identical rows, 1 = nothing in common (or a column changed). */
  changed: number;
  /** Plain words for the build row and the owner's notice. */
  why: string;
  /** No baseline to compare against — the live worker could not produce rows at all. */
  noBaseline?: boolean;
  /**
   * NEITHER side could produce rows, so there was nothing to measure (BEA-1494).
   *
   * Different from `noBaseline`, where the live worker is broken and the repair works. This is the
   * case where the ruler itself is missing — no saved answers exist for these tools at all.
   */
  unmeasurable?: boolean;
};

/**
 * The promotion guard (§G): *"a repair that changes rows on the parity suite by more than a set
 * tolerance is not auto-promoted — it is offered to the owner instead."*
 *
 * Both versions are run through the SAME app-written harness on the SAME saved answers, so the only
 * thing that can differ is the worker. Three verdicts:
 *
 *  - **no baseline** — the live worker cannot produce rows from these answers at all (which is the
 *    ordinary repair case: it is broken, that is why we are here). There is nothing to preserve, so a
 *    green repair goes live;
 *  - **within tolerance** — the same columns and almost the same rows: plumbing. It goes live;
 *  - **beyond it** — a different answer. It is held, and the owner is told what changed.
 */
export function driftOf(before: ParityResult | null, after: ParityResult | null): Drift {
  // NOTHING TO MEASURE IS NOT THE REPAIR'S FAULT (BEA-1494).
  //
  // Checking the repair first meant that when NEITHER side could produce rows, the repair got the
  // blame — "the repaired worker could not produce rows from the saved answers at all" — and the fix
  // was held while the version that had already failed a real run stayed live.
  //
  // That is exactly what happened to his email job, and it was guaranteed to: it reads Gmail, and
  // Gmail is never sampled ON PURPOSE, because it is his mail. So no saved answers exist, the ruler
  // measures nothing on either side, and the guard held every repair for ever. A guard that can never
  // pass is not protecting anything — it just keeps the broken version live.
  //
  // When there is nothing to compare, there is also nothing the repair could quietly change, which is
  // the only thing this guard exists to catch. So it passes, and says plainly that it measured nothing.
  const afterBlank = !after || !after.ok;
  const beforeBlank = !before || !before.ok;
  if (afterBlank && beforeBlank) {
    return {
      within: true,
      changed: 0,
      unmeasurable: true,
      noBaseline: true,
      why: 'neither the live worker nor the repair can produce rows from saved answers — there are none for these tools, so there is nothing to compare and nothing the repair could quietly change',
    };
  }
  // The repair alone came back empty while the live worker manages rows: that IS the repair's fault.
  if (afterBlank) return { within: false, changed: 1, why: 'the repaired worker could not produce rows from the saved answers at all' };
  if (beforeBlank) {
    return {
      within: true,
      changed: 0,
      noBaseline: true,
      why: `the worker that is live now cannot produce rows from the saved answers${before?.error ? ` (${short(before.error)})` : ''}, so there is nothing the repair could quietly change`,
    };
  }
  const beforeCols = (before.columns || []).map(String);
  const afterCols = (after.columns || []).map(String);
  if (beforeCols.join(' ') !== afterCols.join(' ')) {
    return {
      within: false,
      changed: 1,
      why: `the columns changed: it used to give ${beforeCols.join(', ') || 'no columns'} and now gives ${afterCols.join(', ') || 'no columns'}`,
    };
  }
  const a = counted(before.rowKeys || []);
  const b = counted(after.rowKeys || []);
  let differing = 0;
  for (const [k, n] of a) differing += Math.max(0, n - (b.get(k) || 0));
  for (const [k, n] of b) differing += Math.max(0, n - (a.get(k) || 0));
  const total = Math.max(before.rowKeys?.length || 0, after.rowKeys?.length || 0, 1);
  // Rows counted twice above (one gone, one arrived) are one row that changed, not two.
  const changed = Math.min(1, differing / 2 / total);
  const within = changed <= PARITY_TOLERANCE;
  const rowsBefore = before.rows ?? before.rowKeys?.length ?? 0;
  const rowsAfter = after.rows ?? after.rowKeys?.length ?? 0;
  return {
    within,
    changed,
    why: changed === 0
      ? `it gives exactly the same ${rowsAfter} row${rowsAfter === 1 ? '' : 's'} as before`
      : `${Math.round(changed * 100)}% of the rows are different (${rowsBefore} row${rowsBefore === 1 ? '' : 's'} before, ${rowsAfter} after)`,
  };
}

function counted(keys: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of keys) m.set(k, (m.get(k) || 0) + 1);
  return m;
}

// ---- the repair brief --------------------------------------------------------------------------

export type RepairInputs = {
  job: { id: string; name?: string | null };
  attempt: number;
  /** What the run failed with, word for word. */
  error: string;
  cause: FailureCause;
  contract: WorkerContract;
  planInWords: string;
  fetches: FetchEvidence[];
  /** The version the repair starts from — its files are already in the folder. */
  fromVersion: number | null;
  /** What the previous attempt tried and why it did not work. */
  previousTries?: string[];
};

/** The file the failing answers are written into, beside `samples/`. */
export const FAILING_FILE = 'samples/failing.json';

/** Below this many characters a cut answer says nothing worth reading — the shrink loop's floor. */
const TRIM_ANSWER_FLOOR = 2_000;

/**
 * The failing evidence, as a file in the repair's own folder: what each source really answered on
 * the run that broke, and the error and contract that judged it. This is the difference between a
 * repair that reads what happened and a repair that guesses.
 *
 * `capBytes` is the runner's OWN per-file limit, read off its `/status` — never a number restated
 * here (BEA-1577). Evidence bigger than the cap used to be sent whole, refused by the runner, and
 * the refusal counted as a repair attempt in which Codex was never asked anything. Now it is
 * trimmed to fit BEFORE sending: the biggest answers are cut to a head, the oldest sources are
 * dropped when cutting is not enough (the newest are what broke last, so they are kept), and the
 * file says inside itself exactly what was cut. A repair with trimmed evidence is better than no
 * repair. No cap (`null`/0 — an older runner, or one that did not answer) means no trimming.
 */
export function failingFile(inp: RepairInputs, capBytes?: number | null): string {
  const sources = inp.fetches.map((f) => ({
    sourceId: f.sourceId,
    actionId: f.actionId,
    label: f.label || null,
    rows: f.rows ?? 0,
    columns: f.columns || [],
    unrecognised: !!f.unrecognised,
    empty: !!f.empty,
    why: f.why || null,
    answer: f.answer ?? null,
  }));
  const doc = (extra: Record<string, any>, src: any[]) =>
    JSON.stringify(
      {
        note: 'The run that broke. Each source\'s `answer` is exactly what kit.fetchSource(sourceId) returned on that run — the answer that broke the worker. Use it as a fixture: reproduce the failure first, then fix it.',
        ...extra,
        failedWith: inp.error,
        rule: inp.cause.rule,
        ruleInWords: inp.cause.label,
        contract: inp.contract,
        sources: src,
      },
      null,
      2,
    );

  let out = doc({}, sources);
  const cap = Number(capBytes) > 0 ? Math.floor(Number(capBytes)) : 0;
  if (!cap || Buffer.byteLength(out, 'utf8') <= cap) return out;

  // Over the runner's limit. Cut answers first; drop the OLDEST sources only when that is not
  // enough (the journal writes them in call order, so the newest sit at the end); shrink further
  // as the last resort. The loop always terminates: every round makes the file strictly smaller.
  const originalBytes = Buffer.byteLength(out, 'utf8');
  let keep = [...sources];
  let dropped = 0;
  let allow = Math.max(TRIM_ANSWER_FLOOR, Math.floor(cap / Math.max(1, keep.length)));
  for (let round = 0; round < 60; round++) {
    const cut = keep.map((s) => {
      const json = JSON.stringify(s.answer ?? null);
      if (json.length <= allow) return s;
      return { ...s, answer: null, answerTrimmed: { bytes: Buffer.byteLength(json, 'utf8'), head: json.slice(0, allow) } };
    });
    out = doc(
      {
        trimmed: true,
        trimNote:
          `This evidence was ${originalBytes} bytes — more than the ${cap} bytes the runner accepts for one file — so it was cut to fit. ` +
          `An answer bigger than that budget keeps only the first ${allow} characters of its JSON, as answerTrimmed.head` +
          (dropped ? `, and the ${dropped} oldest source${dropped === 1 ? '' : 's'} (of ${sources.length}) ${dropped === 1 ? 'was' : 'were'} dropped entirely — the newest are kept` : '') +
          '. rows/columns/flags are intact. A cut answer cannot be replayed verbatim: treat the head as a shape hint, not a fixture.',
      },
      cut,
    );
    if (Buffer.byteLength(out, 'utf8') <= cap) return out;
    if (allow > TRIM_ANSWER_FLOOR) allow = Math.max(TRIM_ANSWER_FLOOR, Math.floor(allow / 2));
    else if (keep.length > 1) { keep = keep.slice(1); dropped++; }
    else if (allow > 50) allow = Math.max(50, Math.floor(allow / 2));
    else break;
  }
  // Even one source with a 50-character head does not fit — the rest of the file (error, contract)
  // is what is over. Send it as it stands: the runner will refuse it as `notStarted`, which does
  // not count as an attempt, and the cause stays queued rather than burning the owner's two tries.
  return out;
}

/** The brief for one repair turn. Pure, so a test reads exactly what Codex will read. */
export function repairBrief(inp: RepairInputs): string {
  const tried = (inp.previousTries || []).filter(Boolean);
  return `# Repair the worker for "${inp.job.name || inp.job.id}"

This job's worker is live and it **failed on its last run**. You are in a NEW version folder that
already holds a copy of ${inp.fromVersion ? `v${inp.fromVersion}` : 'the live version'} — the same \`worker.mjs\` and \`worker.test.mjs\` that broke.
Fix them here. ${inp.fromVersion ? `v${inp.fromVersion}` : 'The live version'} keeps running until this one passes its tests, so nothing is worse while you work.

This is repair attempt **${inp.attempt} of ${MAX_ATTEMPTS}**. After ${MAX_ATTEMPTS}, the job is switched off and the owner is
told what broke and what was tried — so a fix that is not really a fix costs him his agent.

## What went wrong

The run failed with:

> ${short(inp.error, 600)}

In plain words: **${inp.cause.label}**${inp.cause.actionId ? ` — on \`${inp.cause.actionId}\`` : ''}.
${tried.length ? `\n### What has already been tried, and did not work\n\n${tried.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\nDo something DIFFERENT. Repeating the last attempt wastes the owner's last try.\n` : ''}
## The answer that broke it

\`${FAILING_FILE}\` holds what every source really answered on that run — the exact object
\`kit.fetchSource(sourceId)\` gave the worker. **Read it before you change a line.** The usual cause is
a vendor moving a field: the answer still arrives, and the code that reads a row out of it no longer
finds what it expects.

Work like this, in this order:

1. Add a test to \`worker.test.mjs\` that feeds the worker the failing answer out of \`${FAILING_FILE}\`
   and **reproduces the failure**. Run it and watch it fail.
2. Then fix \`worker.mjs\` until that test passes.
3. Keep every test that was already there passing too. A repair that breaks the old tests is not a repair.

## The rules that do not move

- **Never call a vendor, from the worker or from a test.** Everything you test against is already in
  this folder: \`${FAILING_FILE}\` and \`samples/\`. There is no network here and there must be no
  attempt at one — a repair loop that could spend the owner's credits would be a worse bug than the
  one you are fixing.
- **Do not edit \`contract.json\`**, and do not weaken the check. It came from the owner's own plan:

${contractInWords(inp.contract).map((l) => `  - ${l}`).join('\n')}

  If the rows genuinely cannot meet it any more, do NOT loosen it — leave the tests failing and say so
  in your final message. Being told the truth is worth more to the owner than a green tick.
- **Do not change what the worker returns** beyond what the fix needs. The repair is measured against
  the live version on the same saved answers: if the rows move, it is held for the owner to look at
  instead of going live. Fixing the plumbing is your job; changing his answer is not.
- Read \`kit/KIT.md\` again if you touch anything to do with the call order — it still has to be the
  same calls in the same order whatever the answers hold.
- ${TRIAL_RULE} Keep that test passing — a repair that starts asking the check for a link
  is not a repair.

## The plan the worker runs (unchanged)

${inp.planInWords}

## When you are done

Run \`node --test worker.test.mjs\` yourself. **Green tests are the only way this repair goes live.**
Then say in one short paragraph: what was actually broken, what you changed, and what you could not
fix. ${SANDBOX_RULE}
`;
}

// ---- what the owner is told --------------------------------------------------------------------

/** The line the owner reads when the loop fixed it by itself. */
export function fixedWords(job: string, cause: FailureCause, version: number, drift: Drift): { headline: string; detail: string } {
  return {
    headline: `${job} fixed itself`,
    detail: `It failed because ${cause.label}${cause.actionId ? ` on ${cause.actionId}` : ''}. Codex repaired it and v${version} is live — ${drift.noBaseline ? 'the version that broke could not produce rows at all, so nothing changed under you' : drift.why}.`,
  };
}

/** The line the owner reads when a repair works but changes the answer — his call, not the loop's. */
export function heldWords(job: string, cause: FailureCause, version: number, drift: Drift): { headline: string; detail: string } {
  return {
    headline: `${job} — a repair is ready, but it changes what you get`,
    detail: `It failed because ${cause.label}${cause.actionId ? ` on ${cause.actionId}` : ''}. Codex has a fix (v${version}) and its tests pass, but ${drift.why} — so it is NOT live. Open the job and decide: put v${version} live, or leave it as it is.`,
  };
}

/**
 * The line the owner reads when the loop gives up: what broke, what was tried, and that the job is
 * genuinely off. Retirement to the plan runner is HIS tap, so the notice names it and nothing here
 * does it — the switch itself is the Worker tab's (piece 9).
 */
export function stopWords(job: string, cause: FailureCause, tries: string[]): { headline: string; detail: string; reason: string } {
  const what = `${cause.label}${cause.actionId ? ` on ${cause.actionId}` : ''}`;
  const tried = tries.length ? tries.map((t, i) => `Try ${i + 1}: ${short(t, 220)}`).join(' · ') : 'nothing could be built at all';
  return {
    headline: `${job} is switched off — I could not fix it`,
    detail: `It kept failing because ${what}. Codex tried ${MAX_ATTEMPTS} times and neither repair passed its own tests (${tried}). The job is switched off so it stops failing every day. Open it to look, or run it the old way — the plan runner still works and switching the worker off is one tap.`,
    reason: `Its worker keeps failing (${what}) and ${MAX_ATTEMPTS} repairs did not fix it. Switched off so it stops failing every day — run it the old way, or look at the repair history.`,
  };
}

function short(s: string, n = 300): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}
