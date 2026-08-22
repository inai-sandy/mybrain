import { ALLOW_EMPTY_NO_CHANGE, ALLOW_EMPTY_SOURCES, MAX_CONTRACT_ROWS, columnsNamedIn, contractFromPlan, contractInWords } from './contract';
import { planFromAgent } from '../social/plan';

// The check itself lives in the kit — plain JavaScript a worker really loads — so it is driven here
// exactly as a worker drives it. One copy of the rules, tested where they run.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkContract, normaliseContract } = require('./kit/kit.js');

/**
 * The contract (BEA-1391, agent workers 6/10 — `specs/AGENT-WORKERS.md` §E).
 *
 * The rule this whole piece exists for, in one line: **0 rows out of an answer that was not empty is
 * a failure; 0 rows because every source genuinely had nothing is a good run.** BEA-1377 is the first
 * kind — 90 answers fetched, 0 rows recognised, an empty sheet written, "done" reported, 101 credits
 * spent — and today's `nothingFound()` is the second, which must not change by a word.
 */

const HASHTAG = 'svc:instagram.search_hashtag';
const FIND = 'svc:instagram.search_profiles';
const POSTS = 'svc:instagram.user_posts';

const contract = (over: any = {}) => normaliseContract({ minRows: 1, maxRows: MAX_CONTRACT_ROWS, columns: [], mustHave: [], freshnessDays: null, allowEmptyWhen: ALLOW_EMPTY_SOURCES, ...over });
const table = (columns: string[], rows: any[][]) => ({ columns, rows });
const NOW = Date.UTC(2026, 7, 22);

describe('contractFromPlan — the contract is derived from the plan, never invented', () => {
  it('an ordinary Social job: at least one row, a runaway cap, and empty only when every source was', () => {
    const plan = planFromAgent({
      id: 'ag1', name: 'Smart home India', prompt: 'Keep every result as fetched.',
      tools: [HASHTAG], toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } } },
      outputDest: 'sheet', mode: 'run',
    });
    const c = contractFromPlan(plan);
    expect(c.minRows).toBe(1);
    expect(c.maxRows).toBe(MAX_CONTRACT_ROWS);
    expect(c.allowEmptyWhen).toBe(ALLOW_EMPTY_SOURCES);
    // The task names no columns, so nothing is asserted about them — a wrong column list would fail
    // a perfectly good run, which is worse than checking nothing.
    expect(c.columns).toEqual([]);
    expect(c.mustHave).toEqual([]);
    expect(c.freshnessDays).toBeNull();
  });

  it('a task that names its columns gets them, and a link column must really carry links', () => {
    const plan = planFromAgent({
      id: 'ag2', name: 'Creators', prompt: 'Shape the posts into columns creator, followers, date and link.',
      tools: [HASHTAG], toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } } },
      outputDest: 'sheet', mode: 'run',
    });
    const c = contractFromPlan(plan);
    expect(c.columns).toEqual(['creator', 'followers', 'date', 'link']);
    expect(c.mustHave).toEqual(['link']);
  });

  it('a creators-first window becomes the freshness rule', () => {
    const plan = planFromAgent({
      id: 'ag3', name: 'Profiles', prompt: 'Keep every result as fetched.',
      tools: [FIND, POSTS],
      toolArgs: { [FIND]: { kind: 'creators', find: { actionId: FIND, args: { query: 'smart home' }, take: 30 }, then: { actionId: POSTS, argsFrom: { handle: 'username' }, keepDays: 30 } } },
      outputDest: 'sheet', mode: 'run',
    });
    expect(contractFromPlan(plan).freshnessDays).toBe(30);
  });

  it('a Watch may finish with nothing — that is its right answer, not a failure', () => {
    const plan = planFromAgent({
      id: 'ag4', name: 'Watcher', prompt: 'Keep every result as fetched.',
      tools: [HASHTAG], toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } } },
      outputDest: 'document', mode: 'watch',
    });
    const c = contractFromPlan(plan);
    expect(c.minRows).toBe(0);
    expect(c.allowEmptyWhen).toBe(ALLOW_EMPTY_NO_CHANGE);
  });

  it('reads a column list out of a task, and refuses to guess one out of prose', () => {
    expect(columnsNamedIn('give me the good ones, nicely summarised')).toEqual([]);
    expect(columnsNamedIn('columns: creator, followers and link.')).toEqual(['creator', 'followers', 'link']);
    // the little word in front of a name is not part of the name
    expect(columnsNamedIn('add columns for creator and the link')).toEqual(['creator', 'link']);
    // Prose after the word "column" is not a column list.
    expect(columnsNamedIn('add a column that explains why each one is interesting to me')).toEqual([]);
    // A sentence is trusted only for single-word names — "into columns for easy reading, please"
    // must never invent a column called "easy reading" and fail every run for ever.
    expect(columnsNamedIn('Shape the rows into columns for easy reading, please')).toEqual([]);
    // …but the same list spelled out after a colon is a list, two-word names and all.
    expect(columnsNamedIn('columns: date posted, link')).toEqual(['date posted', 'link']);
  });
});

describe('contractInWords — the owner reads what his agent checks', () => {
  it('says every rule in plain English, including the one that matters most', () => {
    const words = contractInWords(contractFromPlan(planFromAgent({
      id: 'ag5', name: 'Creators', prompt: 'Shape them into columns creator, followers and link.',
      tools: [FIND, POSTS],
      toolArgs: { [FIND]: { kind: 'creators', find: { actionId: FIND, args: { query: 'smart home' }, take: 30 }, then: { actionId: POSTS, argsFrom: { handle: 'username' }, keepDays: 30 } } },
      outputDest: 'sheet', mode: 'run',
    })));
    const all = words.join('\n');
    expect(all).toMatch(/at least 1 row/i);
    expect(all).toMatch(/creator, followers, link/);
    expect(all).toMatch(/Most rows must actually carry a link/i);
    expect(all).toMatch(/last 30 days/i);
    expect(all).toMatch(/recognising nothing out of an answer that DID have something in it is a failure/i);
    // No JSON, no field names, no jargon.
    expect(all).not.toMatch(/minRows|allowEmptyWhen|\{/);
  });
});

describe('kit.expect — the BEA-1377 boundary', () => {
  const empty = (label: string) => ({ label, empty: true, unrecognised: false, why: 'no posts found (vendor answered not_found)', rows: 0 });
  const broken = (label: string, why: string) => ({ label, empty: true, unrecognised: true, why, rows: 0 });
  const answered = (label: string, rows: number) => ({ label, empty: false, unrecognised: false, why: null, rows });

  it('BEA-1377: 90 answers, 0 rows recognised → FAILS with the reason the owner can read', () => {
    const why = 'fetched 90 answers but recognised 0 rows — this is a My Brain bug, not the vendor';
    const v = checkContract(table([], []), contract(), [broken('Instagram · Search Profiles → their posts', why)], NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/fetched 90 answers but recognised 0 rows/i);
    expect(v.reason).toMatch(/not an empty day at the vendor, it is a bug here/);
    expect(v.reason).toMatch(/Nothing was written/);
  });

  it('every source genuinely empty → PASSES with 0 rows, exactly as nothingFound() has always done', () => {
    const v = checkContract(table([], []), contract(), [empty('Instagram · Search Hashtag Posts'), empty('Instagram · Reels Search')], NOW);
    expect(v.ok).toBe(true);
    expect(v.rows).toBe(0);
    expect(v.empty).toBe(true);
  });

  it('one source empty and one broken is still a failure — the bug is not excused by the quiet one', () => {
    const v = checkContract(table([], []), contract(), [empty('Reels Search'), broken('Their posts', 'fetched 12 answers but recognised 0 rows — this is a My Brain bug, not the vendor')], NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/fetched 12 answers/i);
  });

  it('a source that answered and produced nothing is a failure too, and names who', () => {
    const v = checkContract(table(['id'], []), contract(), [answered('Instagram · Search Hashtag Posts', 0)], NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/Instagram · Search Hashtag Posts/);
    expect(v.reason).toMatch(/recognised 0 rows/);
  });

  it('"never" means an empty day fails too, when the owner asked for that', () => {
    const v = checkContract(table([], []), contract({ allowEmptyWhen: 'never' }), [empty('Search')], NOW);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/never all right/i);
  });

  it('rows that are there pass, and the count comes back', () => {
    const v = checkContract(table(['id', 'link'], [['p1', 'https://x/1'], ['p2', 'https://x/2']]), contract(), [answered('Search', 2)], NOW);
    expect(v).toMatchObject({ ok: true, rows: 2, empty: false });
  });

  it('too few, too many, a missing column, a blank must-have, and stale rows all fail readably', () => {
    const src = [answered('Search', 3)];
    expect(checkContract(table(['id'], [['p1']]), contract({ minRows: 3 }), src, NOW).reason).toMatch(/at least 3/);
    expect(checkContract(table(['id'], [['a'], ['b'], ['c']]), contract({ maxRows: 2 }), src, NOW).reason).toMatch(/ran away/);
    expect(checkContract(table(['id'], [['a']]), contract({ columns: ['id', 'link'] }), src, NOW).reason).toMatch(/missing the column this job asks for: link/);
    // Every link blank: the vendor moved the field and nobody would have noticed.
    expect(checkContract(table(['id', 'link'], [['a', ''], ['b', null], ['c', '  ']]), contract({ columns: ['link'], mustHave: ['link'] }), src, NOW).reason).toMatch(/Only 0 of 3 rows have a link/);
    // One blank out of three is a blank cell, not a broken column.
    expect(checkContract(table(['id', 'link'], [['a', 'u1'], ['b', ''], ['c', 'u3']]), contract({ columns: ['link'], mustHave: ['link'] }), src, NOW).ok).toBe(true);
    // Freshness: epoch seconds, all older than the window.
    const old = Math.floor((NOW - 90 * 86400_000) / 1000);
    expect(checkContract(table(['id', 'taken_at'], [['a', old]]), contract({ freshnessDays: 30 }), src, NOW).reason).toMatch(/older than the last 30 days/);
    expect(checkContract(table(['id', 'taken_at'], [['a', old], ['b', Math.floor(NOW / 1000) - 3600]]), contract({ freshnessDays: 30 }), src, NOW).ok).toBe(true);
    // No date column at all: freshness cannot be judged, and a run is never failed on a guess.
    expect(checkContract(table(['id'], [['a']]), contract({ freshnessDays: 30 }), src, NOW).ok).toBe(true);
  });

  it('a column name is compared the way a person reads it: "link" matches "Link" and "link_url" does not', () => {
    const src = [answered('Search', 1)];
    expect(checkContract(table(['Link'], [['u']]), contract({ columns: ['link'] }), src, NOW).ok).toBe(true);
    expect(checkContract(table(['link_url'], [['u']]), contract({ columns: ['link'] }), src, NOW).ok).toBe(false);
  });
});
