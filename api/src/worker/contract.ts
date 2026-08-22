import { AgentPlan } from '../social/plan';

/**
 * The contract — what "it worked" means for one job (BEA-1391, agent workers 6/10 —
 * `specs/AGENT-WORKERS.md` §E).
 *
 * This is the BEA-1377 lesson written into the architecture. That run fetched 90 answers, recognised
 * 0 rows, wrote an empty Google Sheet, reported success and cost 101 credits. A worker must know what
 * a good answer looks like BEFORE it writes anything, and it must fail out loud when it does not have
 * one.
 *
 * Two decisions live here, and both are deliberate:
 *
 *  - **The app derives the contract from the plan; Codex does not invent it.** §E says "written by
 *    Codex from the plan". It is written INTO the worker folder by the build turn, but the numbers
 *    come from this pure function, because a contract a model made up can be exactly as wrong as the
 *    bug it is meant to catch — and because the same function renders the plain words the owner reads
 *    in Settings, so what he reads IS what runs. Codex is told to use it and never to edit it.
 *  - **It only asserts what can be known for certain.** A check that fails a good run is worse than
 *    no check: it would teach the owner to ignore the alarm. So `columns` is filled only when the
 *    task names its columns in so many words, and `freshnessDays` only when the plan really carries a
 *    window. Everything else is left open and said as "any columns" in the plain words.
 */

export type WorkerContract = {
  /** Fewer rows than this = a failed run. 1 for an ordinary job, 0 for a Watch (nothing new is a fine answer). */
  minRows: number;
  /** More rows than this means something ran away — a runaway sheet write is a failure too. */
  maxRows: number;
  /** The columns the rows must carry, when the task names them. Empty = any columns. */
  columns: string[];
  /** The columns that must also carry a VALUE in most rows (a link nobody can open is not a row). */
  mustHave: string[];
  /** The rows must be no older than this, when the plan really has a window. */
  freshnessDays: number | null;
  /** The one case where 0 rows is a success, in the owner's words. */
  allowEmptyWhen: string;
};

/** 0 rows is fine ONLY when every source genuinely came back empty. The default for every job. */
export const ALLOW_EMPTY_SOURCES = 'every source returned an empty answer';
/** A Watch that sees no change writes nothing, and that is the right answer. */
export const ALLOW_EMPTY_NO_CHANGE = 'nothing changed since last time';
/** The only value that forbids an empty run outright. */
export const ALLOW_EMPTY_NEVER = 'never';

/** A sheet write bigger than this from a plan of a few pages means something ran away. */
export const MAX_CONTRACT_ROWS = 5000;

/** Columns whose blankness makes a row useless — the one a `mustHave` is worth spending on. */
const IDENTITY_COLUMNS = ['link', 'url', 'permalink'];

/**
 * The contract for a plan. Pure, and the same on the server, in the build turn and in the UI.
 */
/**
 * The contract from the OWNER's own "what it worked means" lines (BEA-1407).
 *
 * The plan-derived contract can only assert what a plan can express. The brief has a section where
 * he says, in his words, what a good run looks like — *"at least 20 mails read, all three groups
 * present, message under 15 lines"* — and that sentence is the only thing that can tell a bad run
 * from a good one for a job like his.
 *
 * Written by the APP, never by Codex, and read **mechanically**: a number he wrote becomes a
 * minimum, words he named as columns become columns. Anything this cannot read with certainty is
 * left out rather than guessed — a check that fails a good run teaches him to ignore the alarm,
 * which is worse than no check at all.
 */
export function contractFromBrief(plan: AgentPlan, successLines: string[]): WorkerContract {
  const base = contractFromPlan(plan);
  const said = (successLines || []).map((l) => String(l || '')).filter(Boolean);
  if (!said.length) return base;
  const text = said.join(' . ');

  // "at least 20 mails" / "20 or more rows" / "minimum 20" — the smallest such number wins, because
  // he is stating a floor and the strictest floor he wrote is the one he meant.
  const mins: number[] = [];
  const re = /\b(?:at least|minimum(?: of)?|no fewer than|more than|over)\s+(\d{1,5})\b|\b(\d{1,5})\s+or more\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = Number(m[1] || m[2]);
    // "more than 20" means 21; "at least 20" means 20. Only the word decides, never a guess.
    if (Number.isFinite(n) && n > 0 && n <= MAX_CONTRACT_ROWS) mins.push(/more than|over/i.test(m[0]) ? n + 1 : n);
  }
  const minRows = mins.length ? Math.max(base.minRows, Math.min(...mins)) : base.minRows;

  const columns = Array.from(new Set([...(base.columns || []), ...columnsNamedIn(text)]));
  const mustHave = Array.from(new Set([...(base.mustHave || []), ...columns.filter((c) => IDENTITY_COLUMNS.includes(c.toLowerCase())).slice(0, 1)]));

  return { ...base, minRows, columns, mustHave };
}

export function contractFromPlan(plan: AgentPlan): WorkerContract {
  const watching = plan.mode === 'watch' || plan.mode === 'alert';
  const columns = columnsNamedIn(plan.shape?.prompt || plan.prompt || '');
  const mustHave = columns.filter((c) => IDENTITY_COLUMNS.includes(c.toLowerCase())).slice(0, 1);
  return {
    minRows: watching ? 0 : 1,
    maxRows: MAX_CONTRACT_ROWS,
    columns,
    mustHave,
    freshnessDays: freshnessOf(plan),
    allowEmptyWhen: watching ? ALLOW_EMPTY_NO_CHANGE : ALLOW_EMPTY_SOURCES,
  };
}

/**
 * The columns a task names, and only those. "…into columns creator, followers, date and link" →
 * four columns; "give me the good ones" → none, and the contract says nothing about columns.
 *
 * Conservative on purpose: a wrong column list would fail a perfectly good run. Anything that reads
 * like prose (more than three words, longer than 30 characters) is dropped rather than guessed at.
 */
export function columnsNamedIn(prompt: string): string[] {
  const text = String(prompt || '');
  const m = /\bcolumns?\b\s*(:|—|-|=|are|is)?\s*([^.\n;]{2,200})/i.exec(text);
  if (!m) return [];
  // "columns: date posted, link" is a list the owner spelled out, so a two-word name is a name.
  // A bare "…columns X, Y and Z" is a sentence, and only single-word names are trusted in one —
  // otherwise "into columns for easy reading, please" invents a column called "easy reading" and
  // fails every run for ever. A check that fails a good run is worse than no check.
  const spelledOut = /^[:—\-=]$/.test(String(m[1] || ''));
  const out: string[] = [];
  for (const raw of m[2].split(/,| and | & /i)) {
    // "add columns for creator and link" — the little word in front of a column name is not part of
    // it, and left in it would invent a column called "for creator" that no run could ever have.
    const c = raw.trim().replace(/^["'`]+|["'`.]+$/g, '').replace(/^(?:the|a|an|each|every|its|their|with|for|of|in|as|to)\s+/i, '').trim();
    if (!c || c.length > 30) continue;
    if (/^(the|a|an|each|every|its|their|with|for|of|in|as|to)$/i.test(c)) continue;
    const words = c.split(/\s+/).length;
    if (words > 3 || (!spelledOut && words > 1)) return []; // prose, not a column list — trust none of it
    if (!out.some((x) => sameColumn(x, c))) out.push(c);
  }
  return out.slice(0, 12);
}

/** The freshness window the plan really carries — a creators block's "keep the last N days". */
function freshnessOf(plan: AgentPlan): number | null {
  let days: number | null = null;
  for (const s of plan.sources || []) {
    if (s.kind !== 'creators') continue;
    const d = s.then?.keepDays;
    if (d && Number.isFinite(d)) days = Math.max(days || 0, Number(d));
  }
  return days;
}

/** "link" · "Link" · "link_url" vs "link url" — a column name is compared the way a person reads it. */
export function sameColumn(a: string, b: string): boolean {
  const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm(a) === norm(b) && !!norm(a);
}

/**
 * The contract in plain words — the sentences the owner reads in the job's Settings (§E: "rendered in
 * plain words in the UI so the owner can read what his agent checks"). One line per rule, in the
 * order they are checked.
 */
export function contractInWords(contract: WorkerContract): string[] {
  const c = contract;
  const lines: string[] = [];
  lines.push(
    c.minRows > 0
      ? `It must find at least ${c.minRows} row${c.minRows === 1 ? '' : 's'}. Fewer than that and the run fails and writes nothing.`
      : 'It may finish with no rows — this job only reports what changed.',
  );
  lines.push(`More than ${c.maxRows.toLocaleString('en-IN')} rows means something ran away, so that fails too.`);
  if (c.columns.length) lines.push(`The rows must have these columns: ${c.columns.join(', ')}.`);
  else lines.push('It does not check the columns — the task does not name any.');
  for (const m of c.mustHave) lines.push(`Most rows must actually carry a ${m} — a column that comes back blank is a failure, not a row.`);
  if (c.freshnessDays) lines.push(`The rows must be from the last ${c.freshnessDays} days.`);
  lines.push(
    c.allowEmptyWhen === ALLOW_EMPTY_NEVER
      ? 'Finding nothing is never all right for this job.'
      : `Finding nothing is fine when ${c.allowEmptyWhen} — but recognising nothing out of an answer that DID have something in it is a failure, and nothing is written.`,
  );
  return lines;
}
