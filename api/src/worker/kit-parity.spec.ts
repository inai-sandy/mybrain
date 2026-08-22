import { makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';

/**
 * THE PARITY SUITE (BEA-1387 — `specs/AGENT-WORKERS.md` §B).
 *
 * For a fixed set of saved `ToolSample`s, a worker's fetch + merge + shape must produce **the same
 * rows** as `runPlan()` on the same plan. This is what lets a worker be trusted in place of the plan
 * runner later: not "it looks similar", but the same rows out of the same saved answers.
 *
 * It is only meaningful because the two roads share the code underneath — one fetcher
 * (`SourceFetchService`), one merge (`mergeTables`), one shaping step (`SocialAgentRunService.
 * shape`), one sheet writer. A worker that re-implemented paging would pass a test like this on the
 * day it was written and drift a week later; this suite exists to catch anyone who tries.
 */

const post = (id: string, over: any = {}) => ({ id, shortcode: `SC${id}`, caption: `post ${id} about smart home`, like_count: 10, url: `https://instagram.com/p/${id}`, taken_at: 1_755_000_000, ...over });

const HASHTAG = 'svc:instagram.search_hashtag';
const REELS = 'svc:instagram.reels_search';

/** Two pages of a hashtag search and one page of reels — with one post that appears in both sources. */
const SAMPLES: SampleFixture[] = [
  { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, data: { posts: [post('p1'), post('p2'), post('p3')], cursor: 'c1' } },
  { actionId: HASHTAG, args: { hashtag: 'smarthomeindia', cursor: 'c1' }, data: { posts: [post('p3'), post('p4')], cursor: null } },
  { actionId: REELS, args: { query: 'smart home' }, data: { reels: [post('p5'), post('p2')] } },
];

const CARDS = { [HASHTAG]: { paging: { how: 'cursor', field: 'cursor', pageSize: 3 } } };

const job = () => ({
  id: 'ag1',
  name: 'Smart home India',
  prompt: 'Keep the posts about smart home in India — columns id, caption, link.',
  tools: [HASHTAG, REELS],
  toolArgs: {
    [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, _pages: 2 },
    [REELS]: { actionId: REELS, args: { query: 'smart home' } },
  },
  outputDest: 'sheet',
  sheetId: null,
  sheetAppend: false,
  notifyWhatsApp: true,
  mode: 'run',
});

/** The worker a build turn would write for this plan: fetch each source, merge, shape, write, tell. */
async function workerScript(kit: any, title: string, prompt: string, sourceIds: string[] = [HASHTAG, REELS]) {
  await kit.step('Fetching directly — no engine turn for this', 'done');
  const tables: any[] = [];
  for (const sourceId of sourceIds) {
    const got = await kit.fetchSource(sourceId);
    if (got.table) tables.push({ id: got.label, table: got.table });
  }
  const merged = await kit.merge(tables);
  const shaped = await kit.shape(merged, { prompt });
  const table = { columns: shaped.columns, rows: shaped.rows };
  const w = await kit.writeSheet(table, { title });
  await kit.notify({ whatsapp: true }, { headline: `${table.rows.length} rows → ${w.url}`, title });
  await kit.finish({ resultText: `${table.rows.length} rows`, outputUrl: w.url });
  return table;
}

describe('parity: a worker and the plan runner produce the same rows from the same saved answers', () => {
  it('two sources, one paged, one duplicate post across them — same columns, same rows, same order', async () => {
    // ---- the plan runner
    const planWorld = await makeWorld({ job: job(), samples: SAMPLES, cards: CARDS });
    await planWorld.social.run('run-plan', planWorld.agent.job, { title: 'Smart home India' });
    expect(planWorld.agent.finished[0].status).toBe('done');
    const planRows = planWorld.sheets.writes[0].values;

    // ---- the worker, through the callback API, on the same saved answers
    const workerWorld = await makeWorld({ job: job(), samples: SAMPLES, cards: CARDS });
    const { kit } = await spawnKit(workerWorld, 'run-worker', 'ag1');
    await workerScript(kit, 'Smart home India', job().prompt);
    const workerRows = workerWorld.sheets.writes[0].values;

    // The rows written to the sheet are the point of the whole design.
    expect(workerRows).toEqual(planRows);
    // 5 unique posts + the header: p3 repeats inside the paging and p2 across the two sources, and
    // both are dropped once — by the pager's own de-dupe and by the merge's id column.
    expect(planRows).toHaveLength(1 + 5);
    expect(planRows[0]).toEqual(['id', 'caption', 'link']);

    // …and it got there the same way: the same vendor calls, in the same order, with the same args.
    const vendor = (w: any) => w.calls.filter((c: any) => c.id.startsWith('svc:instagram')).map((c: any) => [c.id, JSON.stringify(c.args)]);
    expect(vendor(workerWorld)).toEqual(vendor(planWorld));
    expect(vendor(planWorld)).toHaveLength(3); // two pages of the hashtag, one of the reels
    // every worker call is recorded as a worker call, and never guesses its own identity
    for (const c of workerWorld.calls) if (c.id.startsWith('svc:instagram')) expect(c.ctx).toMatchObject({ runId: 'run-worker', runKind: 'worker', agentId: 'ag1', argsPinned: true });
    // one shaping call each, and the merge de-duped across sources on the same column
    expect(workerWorld.shaped).toEqual(planWorld.shaped);
  });

  it('the same rows when a source comes back empty — the run still writes what it has', async () => {
    const samples = SAMPLES.filter((s) => s.actionId === HASHTAG);
    const emptyJob = () => ({ ...job(), toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, _pages: 2 } }, tools: [HASHTAG] });

    const planWorld = await makeWorld({ job: emptyJob(), samples, cards: CARDS });
    await planWorld.social.run('run-plan', planWorld.agent.job, { title: 'Smart home India' });

    const workerWorld = await makeWorld({ job: emptyJob(), samples, cards: CARDS });
    const { kit } = await spawnKit(workerWorld, 'run-worker', 'ag1');
    await workerScript(kit, 'Smart home India', emptyJob().prompt, [HASHTAG]);

    expect(workerWorld.sheets.writes[0].values).toEqual(planWorld.sheets.writes[0].values);
    expect(planWorld.sheets.writes[0].values).toHaveLength(1 + 4); // p1 p2 p3 p4, p3 de-duped across the two pages
  });

  it('a worker that asks for a call nothing was saved for fails — it never invents an answer', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES, cards: CARDS });
    const { kit } = await spawnKit(world, 'run-worker', 'ag1');
    await expect(kit.fetchSource('svc:instagram.nowhere')).rejects.toThrow(/no source called/i);
  });
});
