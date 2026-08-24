import { readFileSync } from 'fs';
import { join } from 'path';
import { planFromAgent } from '../social/plan';
import { buildRequest, planHashOf, sampleFileName, stable } from './build-brief';
import { WorkerBuildService } from './worker-build.service';

/**
 * The build turn (BEA-1390, agent workers 5/10).
 *
 * The one rule these tests exist to hold: **green tests are the only way a worker goes live.** A
 * build that writes nothing, writes no tests, fails its tests, or passes them and then cannot be put
 * live, must leave the job on the road it was already on — and say so in words the owner can read.
 */

const HASHTAG = 'svc:instagram.search_hashtag';
const PROFILE = 'svc:instagram.profile';
const SEARCH = 'svc:instagram.search_profiles';

const job = (over: any = {}) => ({
  id: 'job-1',
  name: 'Smart home India',
  prompt: 'Keep every result as fetched.',
  tools: [HASHTAG],
  toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, _pages: 2 } },
  outputDest: 'sheet',
  sheetId: 'sheet-1',
  sheetAppend: true,
  notifyWhatsApp: true,
  mode: 'run',
  ...over,
});

const creatorsJob = () =>
  job({
    tools: [SEARCH, PROFILE],
    toolArgs: {
      [SEARCH]: { kind: 'creators', find: { actionId: SEARCH, args: { query: 'smart home' }, take: 50 }, then: { actionId: PROFILE, argsFrom: { handle: 'username' } } },
    },
  });

// ---- a world: an in-memory WorkerBuild table, a fake agent store and a fake runner ---------------

function makeWorld(over: { agent?: any; build?: any; promote?: any } = {}) {
  const rows: any[] = [];
  let n = 0;
  const prisma: any = {
    workerBuild: {
      create: async ({ data }: any) => {
        const row = { id: `b${++n}`, startedAt: new Date(Date.now() + n), finishedAt: null, tests: null, sessionId: null, error: null, log: null, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      findMany: async ({ where, take }: any) => {
        let out = rows.slice().sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
        if (where?.agentId) out = out.filter((r) => r.agentId === where.agentId);
        if (where?.status) out = out.filter((r) => r.status === where.status);
        return take ? out.slice(0, take) : out;
      },
    },
  };
  const agentRow = over.agent || job();
  const agent: any = { getAgent: async (id: string) => (id === agentRow.id ? agentRow : null) };
  const calls: any = { build: [] as any[], promote: [] as any[] };
  const runner: any = {
    build: async (input: any) => {
      calls.build.push(input);
      return over.build ? over.build(input) : { ok: true, version: 1, wrote: true, tests: { passed: 6, failed: 0 }, sessionId: 'sess-1', log: 'tests exited 0' };
    },
    promote: async (input: any) => {
      calls.promote.push(input);
      return over.promote ? over.promote(input) : { ok: true, version: input.version, previous: null };
    },
  };
  const knowledge: any = { lookup: async (ids: string[]) => ids.map((actionId) => ({ actionId, name: actionId, service: 'instagram', provider: 'social', params: [], fields: [{ path: 'id', kind: 'string' }], hasDateField: true, paging: { how: 'cursor', field: 'cursor', pageSize: 12 }, cost: { credits: { typical: 1, min: 1, max: 1 } }, health: { known: true, ok: true }, notes: [], updatedAt: '' })) };
  const samples: any = {
    setPinned: (fn: any) => { samples.pinnedFn = fn; },
    pick: async (actionId: string) => (samples.have === false ? null : { id: `sample-${actionId}`, args: { hashtag: 'smarthomeindia' }, createdAt: new Date('2026-08-22T10:00:00Z'), data: { posts: [{ id: 'p1', caption: 'a smart home post', url: 'https://instagram.com/p/p1' }] } }),
    have: true,
    pinnedFn: null as any,
  };
  const service = new WorkerBuildService(prisma, agent, runner, knowledge, samples);
  service.onModuleInit();
  return { service, rows, calls, agentRow, samples, prisma };
}

// ---- the plan hash -------------------------------------------------------------------------------

describe('the plan hash — what makes a worker stale', () => {
  it('does not move when nothing about the work changed', () => {
    const a = planHashOf(planFromAgent(job()));
    const b = planHashOf(planFromAgent(job({ name: 'Renamed', icon: '🏠', description: 'notes' })));
    expect(a).toBe(b);
  });

  it('moves when the arguments, the pages, the output or the task change', () => {
    const base = planHashOf(planFromAgent(job()));
    expect(planHashOf(planFromAgent(job({ toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'homeautomation' }, _pages: 2 } } })))).not.toBe(base);
    expect(planHashOf(planFromAgent(job({ toolArgs: { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia' }, _pages: 5 } } })))).not.toBe(base);
    expect(planHashOf(planFromAgent(job({ outputDest: 'document' })))).not.toBe(base);
    expect(planHashOf(planFromAgent(job({ prompt: 'Only the ones in India, with columns handle and followers.' })))).not.toBe(base);
  });

  it('is blind to the order the keys happen to be in', () => {
    expect(stable({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(stable({ a: [2, { c: 3, d: 4 }], b: 1 }));
  });
});

// ---- the brief and the folder --------------------------------------------------------------------

describe('the build brief — what Codex is handed', () => {
  const inputs = () => {
    const plan = planFromAgent(job());
    return {
      job: { id: 'job-1', name: 'Smart home India' },
      plan,
      cards: [{ actionId: HASHTAG, name: 'Search Hashtag Posts', service: 'instagram', provider: 'social' as const, params: [], fields: [{ path: 'id', kind: 'string' }], hasDateField: true, paging: { how: 'cursor' as const, field: 'cursor', pageSize: 12 }, cost: { credits: { typical: 1, min: 1, max: 1 }, source: 'observed' as const }, health: { known: true, ok: true }, notes: ['Popular search answers 12 per page.'], updatedAt: '' }] as any,
      samples: [
        {
          sourceId: HASHTAG,
          actionId: HASHTAG,
          args: { hashtag: 'smarthomeindia' },
          sampleId: 'sample-1',
          capturedAt: '2026-08-22T10:00:00Z',
          creditsEstimated: true,
          answer: { ok: true, label: 'Instagram · Search Hashtag Posts', credits: 1, empty: false, unrecognised: false, why: null, stop: null, table: { columns: ['id'], rows: [['p1']], itemCount: 1 } },
        },
      ],
      kit: { version: '1', js: 'exports.makeKit = 1;', doc: '# kit' },
      version: 1,
      previousVersion: null,
      origin: 'build' as const,
      reason: null,
    };
  };

  it('writes the kit, its docs, the plan and the saved answers into the folder', () => {
    const req = buildRequest(inputs());
    expect(Object.keys(req.files).sort()).toEqual(['kit/KIT.md', 'kit/kit.js', 'plan.json', 'contract.json', sampleFileName(HASHTAG), 'samples/index.json'].sort());
    const index = JSON.parse(req.files['samples/index.json']);
    expect(index.sources).toHaveLength(1);
    expect(index.sources[0]).toMatchObject({ sourceId: HASHTAG, sampleId: 'sample-1', rows: 1 });
    expect(req.sampleIds).toEqual(['sample-1']);
    // the answer in the folder is EXACTLY the shape the callback API returns
    expect(JSON.parse(req.files[sampleFileName(HASHTAG)]).answer).toMatchObject({ ok: true, table: { columns: ['id'] } });
  });

  it('says what the worker must do, in the plan\'s own terms, and never carries a secret', () => {
    const req = buildRequest(inputs());
    expect(req.brief).toContain('worker.mjs');
    expect(req.brief).toContain('worker.test.mjs');
    expect(req.brief).toContain('Green tests are the only way');
    expect(req.brief).toContain(HASHTAG);
    expect(req.brief).toContain(req.planHash);
    // no key, no token, no cookie ever reaches a worker folder — the run token is minted per spawn
    const all = req.brief + JSON.stringify(req.files);
    expect(all).not.toMatch(/api[_-]?key|MYBRAIN_TOKEN\s*=|Bearer |password|secret[_-]?key/i);
  });

  /**
   * The contract goes into the folder as a FILE the app wrote (BEA-1391 §E) — Codex is told to use it
   * and never to write one. A contract a model invents can be exactly as wrong as the bug it is
   * supposed to catch, and the owner reads these same words in his Settings.
   */
  it('carries the contract, in JSON and in plain words, and tells Codex not to write its own', () => {
    const req = buildRequest(inputs());
    const contract = JSON.parse(req.files['contract.json']);
    expect(contract).toMatchObject({ minRows: 1, allowEmptyWhen: 'every source returned an empty answer' });
    expect(req.brief).toContain('kit.expect(table, contract)');
    expect(req.brief).toContain('Do not write it, do not edit it');
    expect(req.brief).toContain('It must find at least 1 row.');
    // and the two tests that ARE this piece's acceptance
    expect(req.brief).toContain('The BEA-1377 shape fails loudly');
    expect(req.brief).toContain('Every source genuinely empty still finishes');
  });

  it('says out loud when a source has no saved answer yet, instead of inventing one quietly', () => {
    const inp = inputs();
    const req = buildRequest({ ...inp, samples: [] });
    const index = JSON.parse(req.files['samples/index.json']);
    expect(index.sources[0].file).toBeNull();
    expect(index.sources[0].observedFields).toContain('id (string)');
    expect(req.brief).toContain('no saved answer');
    expect(req.brief).toContain('Do not pretend it is real.');
  });

  it('a creators-first plan reads as one fetch per block, not as a loop the worker writes', () => {
    const req = buildRequest({ ...inputs(), plan: planFromAgent(creatorsJob()) });
    expect(req.brief).toContain('creators first');
    expect(req.brief).toContain(`kit.fetchSource('${SEARCH}')`);
  });
});

// ---- the turn itself ------------------------------------------------------------------------------

describe('the build turn — nothing goes live without green tests', () => {
  it('green tests: the version is promoted, the meta carries the plan hash, and the job has a worker', async () => {
    const w = makeWorld();
    const out = await w.service.build('job-1', { reason: 'first build' });
    expect(out.built).toMatchObject({ ok: true, version: 1 });
    expect(w.calls.promote).toHaveLength(1);
    expect(w.calls.promote[0].meta).toMatchObject({ jobId: 'job-1', version: 1, kit: '1', builtBy: 'codex', origin: 'build', tests: { passed: 6, failed: 0 } });
    expect(w.calls.promote[0].meta.planHash).toBe(out.planHash);
    const state = await w.service.state('job-1');
    expect(state.worker).toMatchObject({ version: 1, status: 'promoted', stale: false });
    expect(state.builds[0].sampleCount).toBe(1);
  });

  it('red tests: nothing is promoted, and the reason names the road the job is still on', async () => {
    const w = makeWorld({ build: () => ({ ok: false, version: 2, wrote: true, tests: { passed: 3, failed: 2 }, log: 'tests exited 1' }) });
    const out = await w.service.build('job-1');
    expect(w.calls.promote).toHaveLength(0);
    expect(out.worker).toBeNull();
    expect(out.built.ok).toBe(false);
    expect(out.builds[0]).toMatchObject({ status: 'failed', version: 2 });
    expect(out.builds[0].error).toContain('3 passed, 2 failed');
    expect(out.builds[0].error).toContain('still running the old way');
  });

  it('a build that writes no worker at all is a failure, not an empty success', async () => {
    const w = makeWorld({ build: () => ({ ok: false, version: 1, wrote: false, tests: null, log: 'codex exited 0' }) });
    const out = await w.service.build('job-1');
    expect(w.calls.promote).toHaveLength(0);
    expect(out.builds[0].error).toContain('did not write a worker.mjs');
  });

  it('a worker that passes but cannot be put live leaves the previous one live, and says why', async () => {
    const w = makeWorld();
    await w.service.build('job-1'); // v1 goes live
    const failing = makeWorldOnTop(w, { promote: () => ({ ok: false, error: 'the workers folder is read-only' }), build: () => ({ ok: true, version: 2, wrote: true, tests: { passed: 4, failed: 0 } }) });
    const out = await failing.build('job-1');
    expect(out.built.ok).toBe(false);
    expect(out.worker).toMatchObject({ version: 1 }); // still v1
    expect(out.builds[0].error).toContain('could not be put live');
    expect(out.builds[0].error).toContain('v1 is still the live worker');
  });

  it('editing the plan marks the live worker stale — it keeps running, and a rebuild clears it', async () => {
    const w = makeWorld();
    await w.service.build('job-1');
    expect((await w.service.state('job-1')).stale).toBe(false);

    w.agentRow.toolArgs = { [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'homeautomation' }, _pages: 2 } };
    const stale = await w.service.state('job-1');
    expect(stale.stale).toBe(true);
    expect(stale.worker).toMatchObject({ version: 1, status: 'promoted', stale: true }); // still live

    const rebuilt = makeWorldOnTop(w, { build: () => ({ ok: true, version: 2, wrote: true, tests: { passed: 6, failed: 0 } }) });
    const after = await rebuilt.build('job-1');
    expect(after.stale).toBe(false);
    expect(after.worker).toMatchObject({ version: 2 });
    expect(after.builds[0].origin).toBe('rebuild');
  });

  it('a job with no plan of sources is refused in plain words, never compiled into nothing', async () => {
    const w = makeWorld({ agent: job({ toolArgs: null, tools: [] }) });
    await expect(w.service.build('job-1')).rejects.toThrow(/nothing to fetch from yet/i);
    const state = await w.service.state('job-1');
    expect(state.compilable).toBe(false);
    // The reason is now the real one, in true words (BEA-1454) — not a sentence about an engine road
    // that a brief-built agent does not have.
    expect(state.reason).toContain('nothing to fetch from yet');
  });

  it('only the LIVE worker\'s saved answers are pinned against the eviction sweep', async () => {
    const w = makeWorld();
    await w.service.build('job-1');
    const pinned = await w.samples.pinnedFn();
    expect(pinned).toEqual([`sample-${HASHTAG}`]);

    // a build that failed pins nothing — its samples are as evictable as any other
    const failing = makeWorldOnTop(w, { build: () => ({ ok: false, version: 2, wrote: true, tests: { passed: 0, failed: 1 } }) });
    await failing.build('job-1');
    expect(await w.samples.pinnedFn()).toEqual([`sample-${HASHTAG}`]);
  });
});

/** The same tables and job, a different runner — for "what happens on the NEXT build". */
function makeWorldOnTop(w: any, over: { build?: any; promote?: any }): WorkerBuildService {
  const runner: any = {
    build: async (input: any) => (over.build ? over.build(input) : { ok: true, version: 2, wrote: true, tests: { passed: 6, failed: 0 } }),
    promote: async (input: any) => (over.promote ? over.promote(input) : { ok: true, version: input.version, previous: 'v1' }),
  };
  const agent: any = { getAgent: async (id: string) => (id === w.agentRow.id ? w.agentRow : null) };
  const knowledge: any = { lookup: async () => [] };
  return new WorkerBuildService(w.prisma, agent, runner, knowledge, w.samples);
}

/**
 * A brief may not promise what an agent cannot do (BEA-1454).
 *
 * The owner ran a real trial and it failed with *"this job runs on the engine, not on a plan of
 * sources"* — a good refusal, in words that were not true (a brief-built agent has no engine road),
 * four steps after the point where the real problem should have been raised.
 *
 * The real problem: his brief named `search_brain` and `remember`, and **a worker cannot call
 * either**. Left alone it would have created a new Notion master page every night.
 */
describe('what a job must have before it can be compiled (BEA-1454)', () => {
  const check = (job: any) => (WorkerBuildService as any).whyNotCompilableFor(job);
  const gmail = { 'svc:gmail.fetch_emails': { actionId: 'svc:gmail.fetch_emails', args: {} } };

  it('accepts a job that WRITES — the tools do not all have to be sources', () => {
    // This is the case that was rejected. Notion actions are not sources; they are what it does
    // with what it fetched.
    expect(check({
      tools: ['svc:gmail.fetch_emails', 'svc:notion.create_notion_page', 'svc:notion.add_multiple_page_content'],
      toolArgs: gmail,
    })).toBe('');
  });

  it('refuses a tool no agent can call, and names it', () => {
    const why = check({ tools: ['svc:gmail.fetch_emails', 'search_brain', 'remember'], toolArgs: gmail });
    expect(why).toContain('search_brain');
    expect(why).toContain('remember');
    expect(why).toContain('are not things an agent can use');
    // And it says what to do, rather than only what is wrong.
    expect(why).toContain('say what it should do instead');
  });

  it('gets the grammar right for one', () => {
    const why = check({ tools: ['svc:gmail.fetch_emails', 'remember'], toolArgs: gmail });
    expect(why).toContain('is not something an agent can use');
  });

  it('refuses a job with nothing to fetch, in plain words', () => {
    expect(check({ tools: ['svc:gmail.fetch_emails'], toolArgs: null })).toContain('nothing to fetch from yet');
  });

  it('never says "runs on the engine" — a brief-built agent has no engine road', () => {
    for (const job of [{ tools: [], toolArgs: null }, { tools: ['remember'], toolArgs: gmail }]) {
      expect(check(job)).not.toMatch(/runs on the engine/i);
    }
  });
});

/**
 * One rule, in both places (BEA-1454).
 *
 * His first real brief built and PROMOTED — Codex wrote the program, seven tests passed, the symlink
 * moved. And the trial still died, with a generic sentence, because the status check two functions
 * away was still asking the OLD question ("can the plan runner do this whole job?"). It answered no,
 * so no hash was computed; an empty hash never equals the one stamped on the worker; a brand-new
 * build read as STALE and was thrown away.
 *
 * I had fixed the rule at the build an hour earlier and left its twin behind. Fifth time in a week
 * for the same habit, so: one function, and a test that fails if a second one appears.
 */
describe('the build and the status ask the SAME question (BEA-1454)', () => {
  it('a job that writes is compilable, and gets a real hash rather than an empty one', () => {
    const job = {
      id: 'j1',
      tools: ['svc:gmail.fetch_emails', 'svc:notion.create_notion_page'],
      toolArgs: { 'svc:gmail.fetch_emails': { actionId: 'svc:gmail.fetch_emails', args: {} } },
      prompt: 'Keep every result as fetched.',
    };
    expect((WorkerBuildService as any).whyNotCompilableFor(job)).toBe('');
  });

  it('nothing in the build service asks the plan runner\'s question any more', () => {
    // `isDirectFetchAgent` means "can the PLAN RUNNER do this whole job", which is a different thing
    // from "can this be compiled" the moment a brief can name what it writes with.
    const src = readFileSync(join(__dirname, 'worker-build.service.ts'), 'utf8');
    expect(src).not.toContain('isDirectFetchAgent');

    // …and the SAME guard on the DISPATCHER, because that is where it came back (BEA-1462).
    // The rule was fixed at the build and at `state()` and left alone here, so a job with a green,
    // promoted worker was sent down the engine road on every run and the owner's screen and his run
    // disagreed about the same job. Three places asking one question is how this keeps happening.
    // Matched on the CALL, not the word — the file explains in comments why both are gone, and a
    // guard that trips on its own explanation teaches people to delete the explanation.
    const dispatch = readFileSync(join(__dirname, 'worker-dispatch.service.ts'), 'utf8');
    expect(dispatch).not.toMatch(/isDirectFetchAgent\s*\(/);
    // The hash too: bare `planHashOf` here could never equal the `buildHashOf(plan, brief)` the
    // build stamps, so any job with an approved brief was told to rebuild for ever.
    expect(dispatch).not.toMatch(/planHashOf\s*\(/);
    expect(dispatch).toContain('buildHashFor');
  });

  it('a refusal is the real reason, not a sentence about a road that no longer exists', () => {
    const why = (WorkerBuildService as any).whyNotCompilableFor({ tools: ['remember'], toolArgs: { 'svc:gmail.fetch_emails': { actionId: 'svc:gmail.fetch_emails', args: {} } } });
    expect(why).toContain('remember');
    expect(why).not.toMatch(/runs on the engine/i);
  });
});
