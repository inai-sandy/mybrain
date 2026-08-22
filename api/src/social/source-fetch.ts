import { ENVELOPE, LIST_KEYS, findList, unwrap } from './rows';
import type { ServiceRunResult } from '../tools/service-actions.service';

/**
 * The pure part of fetching a source (BEA-1387, agent workers 2/10). These four functions used to
 * live at the bottom of `social-agent-run.service.ts`; they moved here so `SourceFetchService` — the
 * ONE fetcher both the plan runner and a worker call — can use them without importing the runner
 * back (a cycle Nest's DI would not survive). `social-agent-run.service.ts` re-exports them, so
 * every existing import keeps working.
 */

/**
 * A vendor "not_found" on a SEARCH is an empty source, not a broken one (BEA-1359): Scrape Creators'
 * Google-indexed searches answer `404 not_found` for a query with no posts. A profile or a post
 * lookup that answers not_found still fails the run — that means the thing does not exist.
 */
export function isEmptySearch(id: string, r: ServiceRunResult): boolean {
  if (!r?.notFound) return false;
  const endpoint = String(id || '').replace(/^svc:/, '').split('.')[1] || '';
  return /search/.test(endpoint);
}

/** What a search finds, for the run's own words: posts · reels · videos · results. */
export function nounOf(id: string): string {
  const endpoint = String(id || '').replace(/^svc:/, '').split('.')[1] || '';
  if (/reel/.test(endpoint)) return 'reels';
  if (/video/.test(endpoint)) return 'videos';
  if (/post|hashtag|keyword|topic|trend/.test(endpoint)) return 'posts';
  return 'results';
}

const plainObj = (v: any) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The items of one per-creator answer: a list → its items; an answer SHAPED like a list with nothing
 * in it (`{items: []}`, `{items: null, user: {…}}` — a list key holding null or an array) → nothing,
 * never one row of envelope; a single-object answer (a profile lookup as the per-creator action) →
 * ONE row, out of its envelope with the same `unwrap` the plain sources use — `{success,
 * data:{user:{…}}}` IS the profile (BEA-1377: `data` is also a list key, and 101 succeeded profile
 * calls were counted as "0 items" because the old check read that key's NAME, not its value).
 */
export function itemsOf(data: any, depth = 0): any[] {
  // findList runs ONLY at the top: it digs one level into every key, and inside the vendor's
  // wrapper that dig pulls a profile's own `bio_links` out as "the list" — the first live re-run
  // (f768… → 6785…) wrote 2 title/url rows per creator with links and LOST those profiles. A real
  // list under the wrapper (`{data:{items:[…]}}`) is already found from the top; past it only an
  // empty list or a single object remains.
  if (depth === 0) {
    const list = findList(data);
    if (list) return list.rows;
  }
  if (Array.isArray(data)) return [];
  if (!data || typeof data !== 'object') return [];
  // The vendor's own envelope wraps the payload in `data` — judge what is INSIDE it, so a stray
  // null list-named field BESIDE the wrapper (`{success, data:{user:{…}}, comments:null}`) can
  // never hide a real profile (found in review of BEA-1377).
  if (plainObj((data as any).data) && depth < 4) return itemsOf((data as any).data, depth + 1);
  // A list answer with nothing in it: a list key holding null / an array findList rejected
  // (a private account's `{items: null, user, more_available:false}`), or a bare array anywhere
  // at the top — that is an empty list, never a row.
  if (Object.entries(data).some(([k, v]) => LIST_KEYS.includes(k) && v !== undefined && !plainObj(v))) return [];
  if (Object.values(data).some((v) => Array.isArray(v))) return [];
  const one = unwrap(data);
  const keys = plainObj(one) ? Object.keys(one).filter((k) => !ENVELOPE.has(k) && one[k] !== undefined && one[k] !== null) : [];
  return keys.length ? [one] : [];
}

/**
 * The tripwire's judge (BEA-1377): true when a SUCCEEDED answer carried a real payload that
 * `itemsOf` could not read as rows — that is OUR bug, never the vendor's. An answer that is empty
 * on purpose (a list key holding null/[], an empty array under any name, the vendor's wrapper
 * around a null payload — `{success, data:{user:null}}` is "no such account" — or envelope only)
 * is NOT a bug and never blamed on My Brain.
 */
export function unrecognisedAnswer(data: any, depth = 0): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (itemsOf(data).length) return false;
  // Judge inside the vendor's `data` wrapper, exactly like itemsOf does (found in review).
  if (plainObj((data as any).data) && depth < 4) return unrecognisedAnswer((data as any).data, depth + 1);
  for (const [k, v] of Object.entries(data)) {
    if (LIST_KEYS.includes(k) && (v === null || Array.isArray(v))) return false; // an empty list, on purpose
    if (Array.isArray(v) && !(v as any[]).length) return false; // an empty list under any name
  }
  return Object.entries(data).some(([k, v]) => !ENVELOPE.has(k) && v !== null && v !== undefined);
}
