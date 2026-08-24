import { makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';
import { contractFromPlan } from './contract';
import { planFromAgent } from '../social/plan';

/**
 * THE BEA-1377 ACCEPTANCE (BEA-1391, agent workers 6/10 — `specs/AGENT-WORKERS.md` §E).
 *
 * This is the failure the whole piece exists for, driven end to end the way it really happened: a
 * creators-first job, every per-creator call **succeeds and carries data**, and no shape in the app
 * reads a row out of it. That run wrote an empty Google Sheet, reported success and cost 101 credits.
 *
 * Everything below the kit is real — the real `WorkerController`, the real journal, the real
 * `SourceFetchService` and its tripwire, the real credit guard — and the answers are replayed out of
 * real `ToolSample` rows. Only the things that leave the building are fakes.
 *
 * Two runs, one boundary:
 *  - **an answer we could not read → the run FAILS and writes nothing** (this test);
 *  - **an answer that was genuinely empty → the run finishes `done` with 0 rows**, exactly as the
 *    plan runner's `nothingFound()` has always behaved.
 */

const FIND = 'svc:instagram.search_profiles';
const POSTS = 'svc:instagram.user_posts';
const HASHTAG = 'svc:instagram.search_hashtag';

/** The finder works: three creators, by name. */
const creators = { users: [{ username: 'a_home' }, { username: 'b_home' }, { username: 'c_home' }] };

/**
 * The vendor changed shape: the payload arrives as a JSON **string** under `data`. The call
 * succeeded, it carries real content, and `itemsOf()` reads no rows out of it — which is precisely
 * the class of answer BEA-1377 counted as "0 items" while reporting success.
 */
const movedShape = (who: string) => ({ success: true, data: JSON.stringify({ user: { username: who, biography: 'smart home' } }) });

const creatorsJob = () => ({
  id: 'ag1',
  name: 'Smart Home Instagram Profiles',
  prompt: 'Keep every result as fetched.',
  tools: [FIND, POSTS],
  toolArgs: {
    [FIND]: { kind: 'creators', find: { actionId: FIND, args: { query: 'smart home india' }, take: 3 }, then: { actionId: POSTS, argsFrom: { handle: 'username' } } },
  },
  outputDest: 'sheet',
  sheetId: null,
  sheetAppend: false,
  notifyWhatsApp: true,
  mode: 'run',
});

const SAMPLES: SampleFixture[] = [
  { actionId: FIND, args: { query: 'smart home india' }, data: creators },
  { actionId: POSTS, args: { handle: 'a_home' }, data: movedShape('a_home') },
  { actionId: POSTS, args: { handle: 'b_home' }, data: movedShape('b_home') },
  { actionId: POSTS, args: { handle: 'c_home' }, data: movedShape('c_home') },
];

/**
 * The worker a build turn writes for this plan — the shape the brief asks for: fetch, merge, CHECK,
 * then write. The check is the only thing between a bad answer and the owner's sheet.
 */
async function worker(kit: any, job: any, sourceIds: string[]) {
  const contract = contractFromPlan(planFromAgent(job));
  try {
    const tables: any[] = [];
    for (const id of sourceIds) {
      const got = await kit.fetchSource(id);
      await kit.step(`Fetched ${got.label}${got.empty ? ` — ${got.why}` : ''}`, 'done');
      // Only a source that brought rows goes into the merge — exactly what the plan runner does
      // (it merges `fetched`, and an empty source never reaches it).
      if (got.table && got.table.rows.length) tables.push({ id: got.label, table: got.table });
    }
    const merged = tables.length ? await kit.merge(tables) : { columns: [], rows: [] };
    const verdict = kit.expect(merged, contract);
    if (verdict.empty) {
      await kit.step('0 rows found — nothing to write, no sheet made', 'done');
      return await kit.finish({ resultText: '0 rows found — nothing to write, no sheet made' });
    }
    const w = await kit.writeSheet(merged, { title: job.name });
    await kit.notify({ whatsapp: true }, { headline: `${merged.rows.length} rows → ${w.url}`, title: job.name });
    return await kit.finish({ resultText: `${merged.rows.length} rows`, outputUrl: w.url });
  } catch (e: any) {
    // Exactly what `KIT.md`'s template does: a ContractError becomes an honest failed run.
    await kit.fail(String(e?.message || e)).catch(() => undefined);
    throw e;
  }
}

describe('contracts: a worker knows what "it worked" means (BEA-1391)', () => {
  it('BEA-1377 shape — 3 answers fetched, 0 rows recognised: the run FAILS, and nothing is written', async () => {
    const world = await makeWorld({ job: creatorsJob(), samples: SAMPLES });
    const { kit } = await spawnKit(world, 'run-1', 'ag1');

    await expect(worker(kit, creatorsJob(), [FIND])).rejects.toThrow(/recognised 0 rows/i);

    // The run failed, and it says why in words the owner can read.
    expect(world.agent.finished).toHaveLength(1);
    expect(world.agent.finished[0].status).toBe('failed');
    expect(world.agent.finished[0].error).toMatch(/fetched 3 answers but recognised 0 rows/i);
    expect(world.agent.finished[0].error).toMatch(/My Brain bug, not the vendor/);
    expect(world.agent.finished[0].error).toMatch(/Nothing was written/);

    // The point of the piece: no sheet, no document, no WhatsApp. This is where 101 credits and an
    // empty sheet went last time.
    expect(world.sheets.created).toHaveLength(0);
    expect(world.sheets.writes).toHaveLength(0);
    expect(world.documents.created).toHaveLength(0);
    expect(world.alerts.sent).toHaveLength(0);

    // …and it really did reach the vendor: the finder plus one call per creator, all successful.
    expect(world.calls.filter((c: any) => c.id === POSTS)).toHaveLength(3);
  });

  it('every source genuinely empty — the run still finishes done with 0 rows, and writes nothing', async () => {
    const job = () => ({
      id: 'ag2', name: 'Two searches', prompt: 'Keep every result as fetched.',
      tools: [HASHTAG], toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } }, [`${HASHTAG}#2`]: { actionId: HASHTAG, args: { hashtag: 'homeautomationindia' } } },
      outputDest: 'sheet', sheetId: null, sheetAppend: false, notifyWhatsApp: true, mode: 'run',
    });
    const samples: SampleFixture[] = [
      { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, notFound: true },
      { actionId: HASHTAG, args: { hashtag: 'homeautomationindia' }, notFound: true },
    ];
    const world = await makeWorld({ job: job(), samples });
    const { kit } = await spawnKit(world, 'run-2', 'ag2');

    await worker(kit, job(), [HASHTAG, `${HASHTAG}#2`]);

    expect(world.agent.finished).toHaveLength(1);
    expect(world.agent.finished[0].status).toBe('done');
    expect(world.agent.finished[0].resultText).toMatch(/0 rows found/);
    expect(world.sheets.created).toHaveLength(0);
    expect(world.sheets.writes).toHaveLength(0);
    expect(world.alerts.sent).toHaveLength(0);

    // The plan runner, on the same job and the same answers, says the same thing — done, 0 rows,
    // nothing written. `allowEmptyWhen` preserves `nothingFound()` exactly.
    const planWorld = await makeWorld({ job: job(), samples });
    await planWorld.social.run('run-plan', planWorld.agent.job, { title: 'Two searches' });
    expect(planWorld.agent.finished[0].status).toBe('done');
    expect(planWorld.agent.finished[0].resultText).toMatch(/0 posts found/);
    expect(planWorld.sheets.writes).toHaveLength(0);
  });

  /**
   * The other half of "preserve `nothingFound()` exactly": a creators source that fetched fine and
   * kept nothing (every post older than the window) is an EMPTY source to the plan runner
   * (`runPlan`: `out.empty || (out.why && mode === 'run')`), not a failure. The contract must agree,
   * or a quiet week would start failing runs that used to finish honestly.
   */
  it('fetched fine but nothing kept in the window — still done with 0 rows, on both roads', async () => {
    const oldPost = (who: string) => ({ items: [{ id: `${who}-1`, caption: 'old', taken_at: Math.floor(Date.now() / 1000) - 200 * 86400 }] });
    const job = () => {
      const j: any = creatorsJob();
      j.id = 'ag5';
      j.toolArgs[FIND].then.keepDays = 30;
      return j;
    };
    const samples: SampleFixture[] = [
      { actionId: FIND, args: { query: 'smart home india' }, data: creators },
      ...['a_home', 'b_home', 'c_home'].map((who) => ({ actionId: POSTS, args: { handle: who }, data: oldPost(who) })),
    ];

    const world = await makeWorld({ job: job(), samples });
    const { kit } = await spawnKit(world, 'run-5', 'ag5');
    await worker(kit, job(), [FIND]);
    expect(world.agent.finished[0].status).toBe('done');
    expect(world.sheets.writes).toHaveLength(0);

    const planWorld = await makeWorld({ job: job(), samples });
    await planWorld.social.run('run-plan-5', planWorld.agent.job, { title: 'Profiles' });
    expect(planWorld.agent.finished[0].status).toBe('done');
    expect(planWorld.sheets.writes).toHaveLength(0);
  });

  it('good rows still go out — the check is a gate, not a wall', async () => {
    const post = (id: string) => ({ id, shortcode: `SC${id}`, caption: `post ${id}`, url: `https://instagram.com/p/${id}` });
    const job = () => ({
      id: 'ag3', name: 'Hashtag', prompt: 'Keep every result as fetched.',
      tools: [HASHTAG], toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } } },
      outputDest: 'sheet', sheetId: null, sheetAppend: false, notifyWhatsApp: true, mode: 'run',
    });
    const world = await makeWorld({ job: job(), samples: [{ actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, data: { posts: [post('p1'), post('p2')] } }] });
    const { kit } = await spawnKit(world, 'run-3', 'ag3');

    await worker(kit, job(), [HASHTAG]);

    expect(world.agent.finished[0].status).toBe('done');
    expect(world.sheets.writes).toHaveLength(1);
    expect(world.sheets.writes[0].values).toHaveLength(1 + 2); // the header and two posts
    expect(world.alerts.sent).toHaveLength(1);
  });

  /**
   * The guard is not "was expect called once". A worker that swallowed the `ContractError`, or that
   * checked one table and wrote another, is the same failure wearing a hat — so the kit remembers the
   * last PASSING check and the rows it passed.
   */
  it('a swallowed ContractError, or checking one table and writing another, is still refused', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { makeKit } = require('./kit/kit.js');
    const reached: string[] = [];
    const kit = makeKit({
      runId: 'run-6', seed: { now: Date.now(), random: 1 },
      contract: { minRows: 2, maxRows: 5000, columns: [], mustHave: [], freshnessDays: null, allowEmptyWhen: 'every source returned an empty answer' },
      fetchImpl: async (route: string) => { reached.push(route); return { ok: true }; },
    });

    // The check fails; the worker swallows it and tries to write anyway.
    try { kit.expect({ columns: ['id'], rows: [['p1']] }); } catch { /* swallowed on purpose */ }
    await expect(kit.writeSheet({ columns: ['id'], rows: [['p1']] }, { title: 'x' })).rejects.toThrow(/did not pass it/i);

    // A passing check does not license writing some OTHER table.
    kit.expect({ columns: ['id'], rows: [['p1'], ['p2']] });
    await expect(kit.writeSheet({ columns: ['id'], rows: [['q9'], ['q8']] }, { title: 'x' })).rejects.toThrow(/not the rows kit.expect\(\) checked/i);
    expect(reached).toEqual([]);
  });

  /**
   * A `contract.json` that exists and cannot be read is NOT "no contract" — running unchecked is the
   * hole this piece closes, so it fails loudly instead.
   */
  it('a contract.json that cannot be read stops the run instead of running unchecked', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os = require('os');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-contract-'));
    fs.mkdirSync(path.join(dir, 'kit'));
    fs.copyFileSync(path.join(__dirname, 'kit', 'kit.js'), path.join(dir, 'kit', 'kit.js'));
    fs.writeFileSync(path.join(dir, 'contract.json'), '{ "minRows": 1, ');   // half-written
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const broken = require(path.join(dir, 'kit', 'kit.js')).makeKit({ runId: 'run-7', seed: { now: Date.now(), random: 1 }, fetchImpl: async () => ({ ok: true }) });
    expect(() => broken.expect({ columns: ['id'], rows: [['p1']] })).toThrow(/contract.json is not readable JSON/i);
    await expect(broken.writeSheet({ columns: ['id'], rows: [['p1']] }, { title: 'x' })).rejects.toThrow(/contract.json is not readable JSON/i);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a worker that skips the check cannot write at all — the kit refuses it', async () => {
    // A kit built WITH a contract, as it is in a real worker folder where `contract.json` sits beside
    // it. Nothing may reach the app: the refusal happens before the call is made.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { makeKit } = require('./kit/kit.js');
    const reached: string[] = [];
    const kit = makeKit({
      runId: 'run-4',
      seed: { now: Date.now(), random: 1 },
      contract: contractFromPlan(planFromAgent(creatorsJob())),
      fetchImpl: async (route: string) => { reached.push(route); return {}; },
    });
    await expect(kit.writeSheet({ columns: ['id'], rows: [['p1']] }, { title: 'x' })).rejects.toThrow(/call kit.expect\(table\) before writing/i);
    await expect(kit.writeDocument({ title: 'x', markdown: '# x' })).rejects.toThrow(/did not pass it/i);
    // …and a message is an output too: the owner is never told about rows nobody checked.
    await expect(kit.notify({ whatsapp: true }, { headline: '2 rows' })).rejects.toThrow(/did not pass it/i);
    expect(reached).toEqual([]);
    // …and once they have passed, the same write goes through.
    kit.expect({ columns: ['id'], rows: [['p1']] });
    await kit.writeSheet({ columns: ['id'], rows: [['p1']] }, { title: 'x' }).catch(() => undefined);
    expect(reached).toEqual(['output']);
  });
});

/**
 * The two ways a run can end with nothing, told apart (BEA-1456).
 *
 * Reading nothing is OUR bug and must fail loudly. Keeping nothing is an answer about his day and
 * must say so in words that are true. They used to share one sentence — "N sources answered but
 * recognised 0 rows" — and his Sunday email run was told its 8 perfectly-read emails were unreadable.
 */
describe('nothing came back, for two very different reasons', () => {
  // The kit's own check, exercised directly on what a run really knows about its fetches.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { checkContract } = require('./kit/kit.js');
  const table = { columns: ['a'], rows: [] as any[][] };
  const base = { minRows: 1, maxRows: 5000, columns: [], mustHave: [], freshnessDays: null, allowEmptyWhen: 'every source returned an empty answer' };

  it('says plainly that things came back and none of them matched', () => {
    const v = checkContract(table, base, [{ id: 's', label: 'Gmail', rows: 8, empty: false, unrecognised: false }], Date.now());
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('8 things came back and none of them matched what you asked to keep');
    // And it tells him how to make a quiet day acceptable, rather than only that it failed.
    expect(v.reason).toContain('If a quiet day is all right');
    // It must NEVER claim we could not read the answer — we read all eight.
    expect(v.reason).not.toContain('recognised 0 rows');
  });

  it('finishes done when he said a quiet day is fine', () => {
    const v = checkContract(table, { ...base, minRows: 0 }, [{ id: 's', label: 'Gmail', rows: 8, empty: false, unrecognised: false }], Date.now());
    expect(v.ok).toBe(true);
    expect(v.empty).toBe(true);
    expect(v.why).toContain('none of them matched');
  });

  it('still fails loudly when we genuinely could not read the answer', () => {
    // The BEA-1377 case: data arrived, no shape here read a row out of it. Our bug, not his day.
    const v = checkContract(table, base, [{ id: 's', label: 'Gmail', rows: 0, empty: false, unrecognised: true, why: 'fetched 8 answers but recognised 0 rows' }], Date.now());
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('it is a bug here');
  });

  it('still finishes done when the vendor genuinely had nothing', () => {
    const v = checkContract(table, base, [{ id: 's', label: 'Gmail', rows: 0, empty: true, unrecognised: false }], Date.now());
    expect(v.ok).toBe(true);
    expect(v.why).toContain('every source came back empty');
  });
});
