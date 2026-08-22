import { makeWorld, spawnKit, SampleFixture } from './worker-harness.testing';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { installDeterminism, WorkerPaused } = require('./kit/kit.js');

/**
 * REPLAY (BEA-1387 — `specs/AGENT-WORKERS.md` §H).
 *
 * A worker that stops to ask the owner something EXITS. Hours or days later the answer arrives and
 * the worker is run AGAIN, from the top — so the whole design stands on this: re-running it must
 * perform **zero repeat fetches, zero repeat sheet writes, zero repeat messages**. And a worker
 * whose call order changes between replays must fail loudly, never do a step twice.
 */

const post = (id: string) => ({ id, shortcode: `SC${id}`, caption: `post ${id}`, like_count: 3, url: `https://instagram.com/p/${id}` });
const HASHTAG = 'svc:instagram.search_hashtag';

const SAMPLES: SampleFixture[] = [{ actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, data: { posts: [post('p1'), post('p2')] } }];

const job = () => ({
  id: 'ag1',
  name: 'Ask first',
  prompt: 'Columns id, caption, link.',
  tools: [HASHTAG],
  toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' } } },
  outputDest: 'sheet',
  sheetId: null,
  notifyWhatsApp: true,
  mode: 'run',
});

/** A worker that fetches, shapes, then asks before it writes anything. */
async function askingWorker(kit: any) {
  await kit.step('Starting');
  const got = await kit.fetchSource(HASHTAG);
  const merged = await kit.merge([{ id: got.label, table: got.table }]);
  const shaped = await kit.shape(merged, { prompt: job().prompt });
  const answer = await kit.ask({ question: `Write these ${shaped.rows.length} rows to the sheet?`, choices: ['Yes', 'No'], ifNoAnswer: 'Yes' });
  if (answer !== 'Yes') return kit.fail('You said not to write them.');
  const w = await kit.writeSheet({ columns: shaped.columns, rows: shaped.rows }, { title: 'Ask first' });
  await kit.notify({ whatsapp: true }, { headline: `${shaped.rows.length} rows → ${w.url}`, title: 'Ask first' });
  await kit.finish({ resultText: `${shaped.rows.length} rows`, outputUrl: w.url });
  return w;
}

describe('a worker pauses on a question and resumes without repeating anything', () => {
  it('re-running after the pause does zero repeat fetches, zero repeat sheet writes, zero repeat messages', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });

    // ---- the first spawn: it fetches, shapes, asks, and exits
    const first = await spawnKit(world, 'run1', 'ag1');
    await expect(askingWorker(first.kit)).rejects.toThrow(WorkerPaused);
    const fetches = () => world.calls.filter((c: any) => c.id === HASHTAG).length;
    expect(fetches()).toBe(1);
    expect(world.shaped).toHaveLength(1);
    expect(world.sheets.writes).toHaveLength(0); // nothing written before the owner answered
    expect(world.alerts.sent).toHaveLength(0);
    expect(world.agent.waitpoints).toHaveLength(1);
    // The spawn's token is dead the moment it parks — a token's life is minutes, not the days a
    // question may wait.
    expect(world.tokens.verify(first.spawn.token)).toBeNull();
    expect(world.tokens.liveCount()).toBe(0);

    // ---- the owner answers, hours later
    world.agent.answer(world.agent.waitpoints[0].id, 'Yes');

    // ---- the second spawn: the same script, from the top, with a fresh token
    const second = await spawnKit(world, 'run1', 'ag1');
    expect(second.spawn.token).not.toBe(first.spawn.token);
    const w = await askingWorker(second.kit);

    expect(fetches()).toBe(1); // ZERO repeat fetches — the answer came out of the journal
    expect(world.shaped).toHaveLength(1); // ZERO repeat AI calls
    expect(world.sheets.writes).toHaveLength(1); // written exactly once
    expect(world.alerts.sent).toHaveLength(1); // told exactly once
    expect(world.agent.steps.filter((s: any) => s.label === 'Starting')).toHaveLength(1); // the log is not doubled
    expect(world.agent.finished).toHaveLength(1);
    expect((w as any).url).toContain('SHEET_1');
    // the frozen clock is the RUN's, so both spawns saw the same "now"
    expect(second.kit.now()).toBe(first.kit.now());
  });

  it('a worker whose call order changed fails loudly and repeats nothing', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const first = await spawnKit(world, 'run2', 'ag1');
    await expect(askingWorker(first.kit)).rejects.toThrow(WorkerPaused);
    world.agent.answer(world.agent.waitpoints[0].id, 'Yes');

    // The second spawn skips the opening step, so every later call lands one place earlier.
    const second = await spawnKit(world, 'run2', 'ag1');
    const shifted = async (kit: any) => {
      const got = await kit.fetchSource(HASHTAG);
      const merged = await kit.merge([{ id: got.label, table: got.table }]);
      await kit.shape(merged, { prompt: job().prompt });
    };
    await expect(shifted(second.kit)).rejects.toThrow(/not repeatable/i);
    expect(world.calls.filter((c: any) => c.id === HASHTAG)).toHaveLength(1); // nothing was done twice
    expect(world.sheets.writes).toHaveLength(0);
  });

  it('a question that is still open parks again — it is never asked twice', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    await expect(askingWorker((await spawnKit(world, 'run3', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    await expect(askingWorker((await spawnKit(world, 'run3', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    expect(world.agent.waitpoints).toHaveLength(1);
    expect(world.calls.filter((c: any) => c.id === HASHTAG)).toHaveLength(1);
  });

  it('a question that ran out of time with no default stops the run honestly — it never waits for ever', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const asker = async (kit: any) => { await kit.ask({ question: 'Which sheet should these go in?' }); };
    await expect(asker((await spawnKit(world, 'run4b', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    world.agent.waitpoints[0].status = 'expired';
    await expect(asker((await spawnKit(world, 'run4b', 'ag1')).kit)).rejects.toThrow(/never answered/i);
  });

  it('a question that ran out of time comes back as the default the worker named', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    await expect(askingWorker((await spawnKit(world, 'run4', 'ag1')).kit)).rejects.toThrow(WorkerPaused);
    const wp = world.agent.waitpoints[0];
    expect(wp.defaultValue).toBe('Yes');
    wp.status = 'expired';
    await askingWorker((await spawnKit(world, 'run4', 'ag1')).kit);
    expect(world.sheets.writes).toHaveLength(1);
  });
});

describe('the worker context is frozen, so a replay takes the same road', () => {
  it('Date.now, new Date(), Math.random and crypto.randomUUID all come from the run journal', async () => {
    const world = await makeWorld({ job: job(), samples: SAMPLES });
    const a = await spawnKit(world, 'run5', 'ag1');
    const sandbox: any = { Date, Math: Object.create(Math), crypto: { randomUUID: () => 'real' } };
    const restore = installDeterminism(a.kit, sandbox);
    const stamps = [sandbox.Date.now(), new sandbox.Date().getTime(), sandbox.Math.random(), sandbox.Math.random(), sandbox.crypto.randomUUID()];
    restore();
    expect(stamps[0]).toBe(a.kit.now());
    expect(stamps[1]).toBe(a.kit.now()); // `new Date()` is the same frozen moment
    expect(sandbox.crypto.randomUUID()).toBe('real'); // put back afterwards

    // A second spawn of the SAME run replays the same numbers, in the same order.
    const b = await spawnKit(world, 'run5', 'ag1');
    const again: any = { Date, Math: Object.create(Math), crypto: { randomUUID: () => 'real' } };
    const restore2 = installDeterminism(b.kit, again);
    expect([again.Date.now(), new again.Date().getTime(), again.Math.random(), again.Math.random(), again.crypto.randomUUID()]).toEqual(stamps);
    restore2();

    // A different run gets its own seed, so two runs are not clones of each other.
    const c = await spawnKit(world, 'run6', 'ag1');
    expect(c.kit.uuid()).not.toBe(a.kit.uuid());
  });
});
