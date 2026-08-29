import { NOT_REPEATABLE } from './run-journal.service';
import { MAX_ATTEMPTS, PARITY_TOLERANCE, causeOf, driftOf, failingFile, fixedWords, heldWords, repairBrief, signature, stopWords } from './repair';
import { WorkerContract } from './contract';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { checkContract } = require('./kit/kit.js');

/**
 * The decisions the self-heal loop makes, on their own (BEA-1393 §G).
 *
 * The most important test in this file is the first one: every failure sentence a worker can die of
 * is produced by the REAL `checkContract()` in the kit, and then named by `causeOf()`. The two are
 * written in different files and have to stay in step for ever — the cap of two attempts is counted
 * per cause, so a rule that stopped being recognised would quietly give one break unlimited repairs.
 */

const contract = (over: Partial<WorkerContract> = {}): WorkerContract => ({
  minRows: 1,
  maxRows: 5000,
  columns: [],
  mustHave: [],
  freshnessDays: null,
  allowEmptyWhen: 'every source returned an empty answer',
  ...over,
});

const source = (over: any = {}) => ({ id: 'src-a', label: 'Instagram · Search Hashtag Posts', empty: false, unrecognised: false, why: null, rows: 0, ...over });

/** What the kit really says when a table fails a contract — the sentence, out of the real function. */
function reasonFor(table: any, c: WorkerContract, sources: any[], now = Date.now()): string {
  const verdict = checkContract(table, c, sources, now);
  expect(verdict.ok).toBe(false);
  return verdict.reason;
}

describe('naming what broke (BEA-1393)', () => {
  const JOB = 'ag1';
  const fetches = [{ sourceId: 'src-a', actionId: 'svc:instagram.search_hashtag' }];

  it('every contract failure the kit can produce is recognised, and none of them reads as a crash', () => {
    const empty = { columns: [], rows: [] };
    const cases: { rule: string; reason: string }[] = [
      {
        rule: 'unrecognised',
        reason: reasonFor(empty, contract(), [source({ empty: true, unrecognised: true, why: 'fetched 90 answers but recognised 0 rows — this is a My Brain bug, not the vendor' })]),
      },
      { rule: 'norows', reason: reasonFor(empty, contract(), [source()]) },
      { rule: 'nofetch', reason: reasonFor(empty, contract(), []) },
      { rule: 'empty', reason: reasonFor(empty, contract({ allowEmptyWhen: 'never' }), [source({ empty: true })]) },
      { rule: 'minRows', reason: reasonFor({ columns: ['id'], rows: [['p1']] }, contract({ minRows: 3 }), [source({ rows: 1 })]) },
      { rule: 'maxRows', reason: reasonFor({ columns: ['id'], rows: [['a'], ['b'], ['c']] }, contract({ maxRows: 2 }), [source({ rows: 3 })]) },
      { rule: 'columns', reason: reasonFor({ columns: ['id'], rows: [['p1']] }, contract({ columns: ['link'] }), [source({ rows: 1 })]) },
      { rule: 'mustHave', reason: reasonFor({ columns: ['id', 'link'], rows: [['p1', ''], ['p2', '']] }, contract({ mustHave: ['link'] }), [source({ rows: 2 })]) },
      {
        rule: 'freshness',
        reason: reasonFor({ columns: ['id', 'date'], rows: [['p1', '2020-01-01']] }, contract({ freshnessDays: 30 }), [source({ rows: 1 })]),
      },
    ];

    for (const c of cases) {
      const cause = causeOf({ jobId: JOB, error: c.reason, fetches });
      expect([c.rule, cause.rule]).toEqual([c.rule, c.rule]); // named, so the failure says which one
      expect(cause.key).toBe(`${JOB}|${c.rule}|svc:instagram.search_hashtag`);
      expect(cause.label).not.toMatch(/^it failed$/);
    }
  });

  it('the kit\'s own refusals — a forgotten check and a changed call order — are their own causes', () => {
    const forgotten = causeOf({
      jobId: JOB,
      error: 'This worker has a contract and these rows did not pass it — call kit.expect(table) before writing or sending anything, and let a ContractError out.',
      fetches,
    });
    expect(forgotten.rule).toBe('uncheckedWrite');
    const wrongTable = causeOf({ jobId: JOB, error: 'These are not the rows kit.expect() checked — check the very rows you are about to write.', fetches });
    expect(wrongTable.rule).toBe('uncheckedWrite');
    const order = causeOf({ jobId: JOB, error: `${NOT_REPEATABLE}: at call 3 it did "writeSheet", but this run did "notify" there.`, fetches });
    expect(order.rule).toBe('notRepeatable');
    const stalled = causeOf({ jobId: JOB, error: 'This run stopped making progress — nothing was written for 20 minutes, so it was stopped.', fetches });
    expect(stalled.rule).toBe('stalled');
  });

  it('a refused call is named by the call it was refused on, not by the run', () => {
    const cause = causeOf({
      jobId: JOB,
      error: 'The worker stopped: Instagram is over the daily credit ceiling.',
      fetches: [
        { sourceId: 'src-a', actionId: 'svc:instagram.search_hashtag' },
        { sourceId: 'src-b', actionId: 'svc:instagram.reels_search', stop: 'over the daily credit ceiling' },
      ],
    });
    expect(cause).toMatchObject({ rule: 'stopped', actionId: 'svc:instagram.reels_search' });
  });

  it('two different crashes are two different causes; the same crash is one, however its numbers move', () => {
    const one = causeOf({ jobId: JOB, error: 'TypeError: Cannot read properties of undefined (reading "caption") at line 42', fetches });
    const again = causeOf({ jobId: JOB, error: 'TypeError: Cannot read properties of undefined (reading "caption") at line 9910', fetches });
    const other = causeOf({ jobId: JOB, error: 'RangeError: Maximum call stack size exceeded', fetches });
    expect(one.rule).toBe('crash');
    expect(one.key).toBe(again.key); // the same break, whatever the line number says
    expect(one.key).not.toBe(other.key);
    expect(signature('abc 123')).toHaveLength(8);
  });

  it('a job-wide failure with several sources names no action, so the cap is the job\'s not one call\'s', () => {
    const many = [
      { sourceId: 'src-a', actionId: 'svc:instagram.search_hashtag' },
      { sourceId: 'src-b', actionId: 'svc:instagram.reels_search' },
    ];
    const cause = causeOf({ jobId: JOB, error: reasonFor({ columns: ['id'], rows: [['p1']] }, contract({ minRows: 3 }), [source({ rows: 1 })]), fetches: many });
    expect(cause).toMatchObject({ rule: 'minRows', actionId: '', key: `${JOB}|minRows|` });
  });
});

describe('the promotion guard (BEA-1393)', () => {
  const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `row${i + from}`);
  const before = { ok: true, rows: 20, columns: ['id', 'link'], rowKeys: keys(20) };

  it('the same rows go live; a tenth changed still goes live; more than that is held', () => {
    expect(driftOf(before, { ...before })).toMatchObject({ within: true, changed: 0 });
    expect(driftOf(before, { ...before }).why).toMatch(/exactly the same 20 rows/);

    const oneMoved = { ...before, rowKeys: [...keys(19), 'somethingelse'] };
    expect(driftOf(before, oneMoved)).toMatchObject({ within: true });
    expect(driftOf(before, oneMoved).changed).toBeLessThanOrEqual(PARITY_TOLERANCE);

    const halfMoved = { ...before, rowKeys: [...keys(10), ...keys(10, 100)] };
    const drift = driftOf(before, halfMoved);
    expect(drift.within).toBe(false);
    expect(drift.changed).toBeGreaterThan(PARITY_TOLERANCE);
    expect(drift.why).toMatch(/50% of the rows are different/);
  });

  it('order alone is not a change — the same rows in another order still go live', () => {
    expect(driftOf(before, { ...before, rowKeys: [...before.rowKeys].reverse() })).toMatchObject({ within: true, changed: 0 });
  });

  it('a repair that cannot be measured at all is held, never promoted', () => {
    expect(driftOf(before, null)).toMatchObject({ within: false });
    expect(driftOf(before, { ok: false, error: 'the version could not be measured' })).toMatchObject({ within: false });
  });

  it('no baseline means nothing could be quietly changed, and it says so in words', () => {
    const drift = driftOf({ ok: false, error: 'the field moved' }, { ...before });
    expect(drift).toMatchObject({ within: true, noBaseline: true });
    expect(drift.why).toMatch(/cannot produce rows from the saved answers \(the field moved\)/);
  });
});

describe('what Codex is told, and what the owner is told (BEA-1393)', () => {
  const cause = causeOf({ jobId: 'ag1', error: 'fetched 90 answers but recognised 0 rows — this is a My Brain bug, not the vendor. Nothing was written: this is not an empty day at the vendor, it is a bug here.', fetches: [{ sourceId: 'src-a', actionId: 'svc:instagram.user_posts', unrecognised: true }] });
  const inputs = {
    job: { id: 'ag1', name: 'Smart Home Instagram Profiles' },
    attempt: 2,
    error: 'Nothing was written: this is not an empty day at the vendor, it is a bug here.',
    cause,
    contract: contract({ columns: ['creator', 'link'], mustHave: ['link'] }),
    planInWords: '1. src-a — svc:instagram.user_posts.',
    fetches: [{ sourceId: 'src-a', actionId: 'svc:instagram.user_posts', unrecognised: true, rows: 0, columns: [], answer: { ok: true, table: null } }],
    fromVersion: 3,
    previousTries: ['the tests did not pass'],
  };

  it('the repair brief carries the failure, the evidence, the tolerance and the two hard rules', () => {
    const brief = repairBrief(inputs);
    expect(brief).toContain('repair attempt **2 of 2**');
    expect(brief).toContain('samples/failing.json');
    expect(brief).toContain('the tests did not pass'); // what attempt 1 tried, so attempt 2 does something else
    expect(brief).toMatch(/Never call a vendor/);
    expect(brief).toMatch(/Do not edit `contract\.json`/);
    expect(brief).toMatch(/held for the owner/);
    expect(brief).toContain('v3'); // it starts from the version that broke, and that one stays live
    expect(brief).toContain('Most rows must actually carry a link'); // the contract in his words
  });

  it('the failing file holds the answer the worker really got, with the error and the contract', () => {
    const file = JSON.parse(failingFile(inputs));
    expect(file).toMatchObject({ rule: 'unrecognised', failedWith: inputs.error });
    expect(file.contract.columns).toEqual(['creator', 'link']);
    expect(file.sources[0]).toMatchObject({ sourceId: 'src-a', actionId: 'svc:instagram.user_posts', unrecognised: true });
  });

  it('evidence over the runner\'s cap is trimmed to fit — answers cut, the newest sources kept, and the file says so (BEA-1577)', () => {
    const big = (id: string) => ({ sourceId: id, actionId: `svc:instagram.${id}`, rows: 5, columns: ['id'], answer: 'x'.repeat(10_000) });
    const inp: any = { ...inputs, fetches: [big('oldest'), big('middle'), big('newest')] };

    // Under the cap (or no cap at all): byte for byte the file it always was — nothing marked, nothing cut.
    expect(failingFile(inp, 10_000_000)).toBe(failingFile(inp));
    expect(JSON.parse(failingFile(inp, 10_000_000)).trimmed).toBeUndefined();

    // Over it, with room for every source: each big answer is cut to a head; none is dropped.
    const roomyRaw = failingFile(inp, 9_000);
    expect(Buffer.byteLength(roomyRaw, 'utf8')).toBeLessThanOrEqual(9_000);
    const roomy = JSON.parse(roomyRaw); // still valid JSON — never a file cut mid-character
    expect(roomy.trimmed).toBe(true);
    expect(roomy.trimNote).toMatch(/cut to fit/);
    expect(roomy.sources.map((s: any) => s.sourceId)).toEqual(['oldest', 'middle', 'newest']);
    for (const s of roomy.sources) {
      expect(s.answer).toBeNull();
      expect(s.answerTrimmed.bytes).toBeGreaterThan(9_000);
      expect(s.answerTrimmed.head.length).toBeGreaterThan(0);
      expect(s).toMatchObject({ rows: 5, columns: ['id'] }); // the counts and flags survive whole
    }

    // Tighter still: the OLDEST sources are dropped, the newest is kept — and the file says so.
    const tightRaw = failingFile(inp, 3_000);
    expect(Buffer.byteLength(tightRaw, 'utf8')).toBeLessThanOrEqual(3_000);
    const tight = JSON.parse(tightRaw);
    expect(tight.sources.map((s: any) => s.sourceId)).toEqual(['newest']);
    expect(tight.trimNote).toMatch(/2 oldest sources \(of 3\) were dropped/);
  });

  it('the three things the owner can be told all name the job, the break and what happens next', () => {
    const fixed = fixedWords('Smart Home', cause, 4, { within: true, changed: 0, why: 'it gives exactly the same 12 rows as before' });
    expect(fixed.headline).toBe('Smart Home fixed itself');
    expect(fixed.detail).toMatch(/v4 is live/);

    const held = heldWords('Smart Home', cause, 4, { within: false, changed: 0.5, why: '50% of the rows are different (12 rows before, 6 after)' });
    expect(held.headline).toMatch(/changes what you get/);
    expect(held.detail).toMatch(/it is NOT live/);
    expect(held.detail).toMatch(/put v4 live, or leave it as it is/);

    const stop = stopWords('Smart Home', cause, ['the tests did not pass', 'it wrote nothing']);
    expect(stop.headline).toMatch(/switched off/);
    expect(stop.detail).toContain(`Codex tried ${MAX_ATTEMPTS} times`);
    expect(stop.detail).toMatch(/Try 1: the tests did not pass · Try 2: it wrote nothing/);
    // Retirement is his tap, never the loop's — the notice offers it in words.
    expect(stop.detail).toMatch(/run it the old way/);
    expect(stop.reason).toMatch(/2 repairs did not fix it/);
  });
});

/**
 * A GUARD THAT CAN NEVER PASS IS NOT PROTECTING ANYTHING (BEA-1494).
 *
 * His email job failed a real run. Codex repaired it 79 seconds later — and the fix sat held, with
 * "the repaired worker could not produce rows from the saved answers at all", while the version that
 * had already failed stayed live.
 *
 * The cause: the job reads Gmail, Gmail is never sampled ON PURPOSE (it is his mail), so no saved
 * answers exist. Neither side could produce rows. `driftOf` checked the repair first, blamed it, and
 * held. For that job the guard could never pass, so every repair was destined to be held for ever.
 */
describe('the guard when there is nothing to measure', () => {
  const blank = () => ({ ok: false, error: 'no saved answers for these tools' } as any);
  // `driftOf` compares rowKeys, not the row arrays — a fixture without them measures nothing and
  // silently passes, which is how the first version of this test fooled itself.
  const rows = (columns: string[], n: number) => ({ ok: true, columns, rows: n, rowKeys: Array.from({ length: n }, (_, i) => `k${i}`) } as any);

  it('lets a repair through when NEITHER side can produce rows, and says it measured nothing', () => {
    const d = driftOf(blank(), blank());
    expect(d.within).toBe(true);
    expect(d.unmeasurable).toBe(true);
    expect(d.why).toContain('nothing to compare');
    // The old message blamed the repair. It must not come back.
    expect(d.why).not.toContain('the repaired worker could not produce rows');
  });

  it('still blames the repair when the LIVE worker manages rows and the repair does not', () => {
    // The case the guard is really for: the live one works, the repair came back empty.
    const d = driftOf(rows(['a'], 3), blank());
    expect(d.within).toBe(false);
    expect(d.why).toContain('the repaired worker could not produce rows');
  });

  it('still lets a repair through when only the live worker is broken', () => {
    const d = driftOf(blank(), rows(['a'], 3));
    expect(d.within).toBe(true);
    expect(d.noBaseline).toBe(true);
    expect(d.unmeasurable).toBeUndefined();
  });

  it('still HOLDS a real change when both sides can be measured', () => {
    // Nothing above may weaken the case this guard was built for.
    const d = driftOf(rows(['a'], 10), rows(['a'], 1));
    expect(d.within).toBe(false);
  });
});
