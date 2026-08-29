import { listIn } from '../tools/tool-lesson';

/**
 * The plan road's "is this obviously wrong?" check (BEA-1403).
 *
 * The incident: "Nightly Important Email Summary" ran twice, reported done, WhatsApped the owner —
 * and had read **one email**. `svc:gmail.fetch_emails` with no `max_results` returns exactly 1
 * message (a silent data-loss default), and the plan runner had no doubt of its own: contracts
 * (`kit.expect`, the BEA-1377 tripwire) lived only on the worker road, while all nine of the
 * owner's agents run on the plan road.
 *
 * These are the pure parts: given the job's OWN recorded `ToolCall` rows (never a global average —
 * another job's query is another ask), does a 1-item answer look obviously wrong? The comparison is
 * by the ASK — the arguments that say WHAT to fetch, with the "how many / which page" arguments
 * (`max_results`, `limit`, `cursor`, `verbose`…) stripped — because the whole bug is that the same
 * query with and without `max_results` is the same ask with wildly different answers (1 vs 6 vs 14
 * on the owner's real inbox, from the recorded rows in the issue).
 *
 * Counting items out of a recorded row is best-effort on purpose: `ToolCall.result` is pretty JSON
 * cut at 2,000 characters, so a big answer does not parse. A truncated result is read as a LOWER
 * bound (the item starts visible before the cut), and a row this cannot read is skipped — the
 * doubt may miss, but it may never cry wolf. A check that fails a good run teaches the owner to
 * ignore the alarm, which is worse than no check.
 */

/** How far back the job's own history is read. */
export const HISTORY_DAYS = 30;
/** How many recorded rows are read, newest first. */
export const HISTORY_ROWS = 120;
/** "Many": a past answer of at least this many items makes a 1-item answer worth doubting. */
export const HISTORY_MANY = 3;

/** What the doubt reads off one recorded `ToolCall` row. */
export type HistoryRow = { arguments?: string | null; result?: string | null; ok?: boolean; createdAt?: Date | string };

/**
 * Arguments that say "how many / which page / how fat", never "what". Stripped before two calls are
 * compared as the same ask. `verbose` / `ids_only` change the size of each item, not which items.
 */
const COUNT_OR_PAGE_PARAM_RE =
  /^(max_?results?|limit|count|per_?page|page_?size|num|top|size|pages?|page_?number|page_?no|cursor|page_?token|next_?page_?token|next_max_id|max_id|min_time|max_cursor|next_page_id|after|offset|start|starting_after|end_cursor|ids_only|verbose)$/i;

/** The ask half of a call's arguments: `_`-keys, count/page/size keys and blanks dropped. */
export function askArgs(args: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) return out;
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('_') || COUNT_OR_PAGE_PARAM_RE.test(k)) continue;
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/** Stable text of a value — objects by sorted keys, so `{a,b}` and `{b,a}` read the same. */
function stable(v: any): string {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** Are these two calls the same ASK? Same non-count arguments, order-blind. */
export function sameAsk(a: any, b: any): boolean {
  return stable(askArgs(a)) === stable(askArgs(b));
}

/**
 * How many items a recorded `ToolCall.result` held — exact when it parses, a LOWER bound when the
 * recorder cut it at 2,000 characters, `null` when nothing can be read (then the row is skipped).
 *
 *  - whole JSON → the list's length (`listIn` — the same reader the lessons use), or 1 for one object;
 *  - a short summary ("6 messages", the Google road's rows) → its number;
 *  - truncated pretty JSON → the item-starts visible before the cut, inside the FIRST list only.
 */
export function recordedItemCount(result: string | null | undefined): number | null {
  const s = String(result ?? '');
  if (!s.trim()) return null;
  try {
    const d = JSON.parse(s);
    if (d === null || typeof d !== 'object') return null;
    const list = listIn(d);
    if (list) return list.items.length;
    return 1; // one object is one thing (a profile, one message)
  } catch { /* truncated, or not JSON at all */ }
  const summary = s.match(/^(\d{1,5})\s+[A-Za-z]/);
  if (summary) return Number(summary[1]);
  // Truncated pretty JSON: `"messages": [\n    {` — count the `},\n    {` separators at the first
  // list's own indent, up to that list's closing bracket when the cut left one visible.
  const open = s.match(/"[A-Za-z_][A-Za-z0-9_]*"\s*:\s*\[\s*\n(\s*)\{/);
  if (!open || open.index === undefined) return null;
  const indent = open[1];
  const tail = s.slice(open.index + open[0].length);
  const parent = indent.slice(0, Math.max(0, indent.length - 2));
  const closeAt = tail.search(new RegExp(`\\n${parent}\\]`));
  const body = closeAt === -1 ? tail : tail.slice(0, closeAt);
  const sep = new RegExp(`\\},\\n${indent}\\{`, 'g');
  let n = 1;
  while (sep.exec(body)) n++;
  return n;
}

/**
 * Does this job's own history show MANY for the same ask? The most a matching recorded row held
 * (≥ `HISTORY_MANY`), or null — then there is nothing to doubt and a quiet day stays a quiet day.
 */
export function historyShowsMany(rows: HistoryRow[], currentArgs: any): { max: number } | null {
  let max = 0;
  for (const r of rows || []) {
    if (r.ok === false) continue;
    let args: any = null;
    try { args = r.arguments ? JSON.parse(r.arguments) : null; } catch { continue; }
    if (!sameAsk(args, currentArgs)) continue;
    const n = recordedItemCount(r.result);
    if (n !== null && n > max) max = n;
  }
  return max >= HISTORY_MANY ? { max } : null;
}

/** The loud sentence on the run — plain, and it says what to check. */
export function doubtLine(name: string, max: number): string {
  return (
    `⚠️ ${name} returned 1 item, but this job's own recorded calls got ${max} or more for the same ask in the last ${HISTORY_DAYS} days — ` +
    `this run may have silently read almost nothing. Check the source's arguments: a missing limit argument (max_results / limit / page_size) makes some vendors answer their tiny default (Gmail answers exactly ONE message).`
  );
}

/** The short form the owner's notification carries — the doubt, never a false all-clear. */
export function doubtShort(name: string, max: number): string {
  return `check this run — ${name} returned 1 item where past runs got ${max}+`;
}

/** Every doubt as ONE notification prefix: the first in full, the rest counted. '' when there is nothing to doubt. */
export function doubtHeadline(doubts: { short: string }[]): string {
  if (!doubts?.length) return '';
  const more = doubts.length > 1 ? ` (+${doubts.length - 1} more source${doubts.length > 2 ? 's' : ''})` : '';
  return `⚠️ ${doubts[0].short}${more}`;
}
