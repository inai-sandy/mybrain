import { KEEP_AS_FETCHED, SHEET_CREATE, SHEET_WRITE, SocialAgentRunService } from './social-agent-run.service';
import { planFromAgent } from './plan';

/**
 * BEA-1369 — the planning blocks the direct runner executes:
 *  - `_pages: N` → up to N pages, one ToolCall each with its credits, the vendor's cursor sent
 *    back, items de-duped by id, an early stop on an empty / repeated page / no cursor, the
 *    ceiling checked before EVERY page;
 *  - creators-first → the finder once, one call per creator, `keepDays` applied when the items
 *    carry a date (the card's field, else the usual names, else everything kept and said), a
 *    `creator` column, one failing creator skipped, honest counts + credits;
 *  - `run()` === `runPlan(planFromAgent(agent))`.
 */

const post = (id: string, over: any = {}) => ({ id, caption: `post ${id}`, like_count: 1, url: `https://instagram.com/p/${id}`, ...over });
const day = 24 * 60 * 60 * 1000;

function harness(opts: { answer: (id: string, args: any, n: number) => any; budget?: { ok: boolean; reason?: string }[]; card?: Record<string, any> }) {
  const steps: any[] = [];
  const finish: any[] = [];
  const calls: { id: string; ctx: any }[] = [];
  const agent = {
    appendStep: jest.fn(async (_id: string, s: any) => { steps.push(s); }),
    finishRun: jest.fn(async (_id: string, p: any) => { finish.push(p); }),
    attachOutput: jest.fn(async () => undefined),
  };
  let n = 0;
  const actions = {
    runDetailed: jest.fn(async (id: string, _input: string, ctx: any) => {
      calls.push({ id, ctx });
      if (id === SHEET_CREATE) return { ok: true, data: { spreadsheetId: 'SHEET_NEW' } };
      if (id === SHEET_WRITE) return { ok: true, data: { totalUpdatedRows: 3 } };
      n++;
      return opts.answer(id, ctx.args, n);
    }),
  };
  const llm = { completeHelper: jest.fn(async () => '{"columns":["creator","link"],"rows":[["a","u1"]]}') };
  const documents = { create: jest.fn(async () => ({ id: 'doc1' })) };
  const alerts = { runFinished: jest.fn(async () => ({ sent: true })), runFailed: jest.fn(async () => ({ sent: false })) };
  const budgetChecks: string[] = [];
  const budgetAnswers = [...(opts.budget || [])];
  const budget = {
    check: jest.fn(async (id: string) => { budgetChecks.push(id); return budgetAnswers.length ? budgetAnswers.shift()! : { ok: true, spent: 0, ceiling: null, estimate: 1 }; }),
    pauseAgent: jest.fn(async () => undefined),
  };
  const knowledge = { card: jest.fn(async (id: string) => opts.card?.[id] ?? null) };
  const svc = new SocialAgentRunService(agent as any, actions as any, llm as any, documents as any, alerts as any, undefined, budget as any, undefined, knowledge as any);
  return { svc, steps, finish, calls, budgetChecks, budget, documents, knowledge };
}

const job = (toolArgs: Record<string, any>, over: any = {}) => ({ id: 'ag1', name: 'Popular digest', prompt: KEEP_AS_FETCHED, tools: Object.keys(toolArgs), toolArgs, outputDest: 'sheet', sheetId: null, notifyWhatsApp: false, mode: 'run', ...over });

describe('pages per source', () => {
  it('_pages: 3 → three ToolCalls, the cursor from each answer sent back with the same args, items de-duped, credits added, one honest step', async () => {
    const h = harness({
      answer: (_id, args, n) => ({ ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Popular Search', data: { success: true, credits_charged: 1, cursor: n < 3 ? `c${n}` : null, posts: [post(`${n}-a`), post(`${n}-b`), post('shared')] } }),
      card: { 'svc:instagram.search_popular': { paging: { how: 'cursor', field: 'cursor', pageSize: 12 } } },
    });
    await h.svc.run('run1', job({ 'svc:instagram.search_popular': { query: 'homeautomation', _pages: 3 } }));
    const fetches = h.calls.filter((c) => c.id === 'svc:instagram.search_popular');
    expect(fetches).toHaveLength(3);
    expect(fetches[0].ctx.args).toEqual({ query: 'homeautomation' }); // _pages is never sent to the vendor
    expect(fetches[1].ctx.args).toEqual({ query: 'homeautomation', cursor: 'c1' });
    expect(fetches[2].ctx.args).toEqual({ query: 'homeautomation', cursor: 'c2' });
    for (const f of fetches) expect(f.ctx).toMatchObject({ runId: 'run1', runKind: 'agent', argsPinned: true });
    // the ceiling was checked before every page
    expect(h.budgetChecks).toEqual(['svc:instagram.search_popular', 'svc:instagram.search_popular', 'svc:instagram.search_popular']);
    // 3 pages × 3 items, "shared" appears on every page → 7 unique rows
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.values).toHaveLength(1 + 7);
    expect(h.steps.some((s) => s.label === 'Fetched Instagram · Popular Search — 7 items over 3 pages · 3 credits' && s.nodeId === 'src:svc:instagram.search_popular')).toBe(true);
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/\*\*7 rows\*\* · 3 credits/);
  });

  it('stops early: no cursor after page 1 → one page; a repeated page → stops and says so; a not_found later page is the end', async () => {
    // no cursor in the answer, and no card → the vendor does not page → 1 call even with _pages 5
    const a = harness({ answer: () => ({ ok: true, credits: 1, data: { posts: [post('x')] } }) });
    await a.svc.run('r', job({ 'svc:instagram.search': { query: 'q', _pages: 5 } }));
    expect(a.calls.filter((c) => c.id === 'svc:instagram.search')).toHaveLength(1);
    expect(a.steps.some((s) => /1 item · 1 credit/.test(s.label))).toBe(true);
    // page 2 repeats page 1 → stop, 2 calls, and the step says why
    const b = harness({ answer: () => ({ ok: true, credits: 1, data: { cursor: 'again', posts: [post('same')] } }) });
    await b.svc.run('r', job({ 'svc:instagram.search': { query: 'q', _pages: 4 } }));
    expect(b.calls.filter((c) => c.id === 'svc:instagram.search')).toHaveLength(2);
    expect(b.steps.some((s) => /1 item over 2 pages · 2 credits · stopped early: page 2 repeated what page 1 had/.test(s.label))).toBe(true);
    expect(b.finish[0].status).toBe('done');
    // page 3 answers not_found on a search → the end of the list, not a failed run
    const c = harness({ answer: (_id, _args, n) => n < 3 ? { ok: true, credits: 1, data: { cursor: `c${n}`, posts: [post(`p${n}`)] } } : { ok: false, notFound: true, credits: 0, error: 'not_found' } });
    await c.svc.run('r', job({ 'svc:instagram.search': { query: 'q', _pages: 5 } }));
    expect(c.calls.filter((x) => x.id === 'svc:instagram.search')).toHaveLength(3);
    expect(c.finish[0].status).toBe('done');
    expect(c.steps.some((s) => /2 items over 2 pages · 2 credits · stopped early: page 3 was empty/.test(s.label))).toBe(true);
    // the same on a NON-search endpoint (user_posts): a not_found on page 2 is the end, the run keeps page 1
    const d = harness({ answer: (_id, _args, n) => n < 2 ? { ok: true, credits: 1, data: { next_max_id: 'm1', items: [post('p1')] } } : { ok: false, notFound: true, credits: 0, error: 'not_found' } });
    await d.svc.run('r', job({ 'svc:instagram.user_posts': { handle: 'x', _pages: 3 } }));
    expect(d.finish[0].status).toBe('done');
    expect(d.steps.some((s) => /1 item · 1 credit · stopped early: page 2 was empty/.test(s.label))).toBe(true);
  });

  it('the ceiling stops a later page: the job pauses, no further call, the run fails with the reason', async () => {
    const h = harness({
      answer: (_id, _args, n) => ({ ok: true, credits: 1, data: { cursor: `c${n}`, posts: [post(`p${n}`)] } }),
      budget: [{ ok: true }, { ok: false, reason: 'The daily Social credit ceiling is 5 and 5 credits are already spent today; this call (about 1 credit) would pass it, so the job paused itself and no call was made.' }],
    });
    await h.svc.run('r', job({ 'svc:instagram.search': { query: 'q', _pages: 3 } }));
    expect(h.calls.filter((c) => c.id === 'svc:instagram.search')).toHaveLength(1);
    expect(h.budget.pauseAgent).toHaveBeenCalledTimes(1);
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/ceiling/);
    expect(h.calls.some((c) => c.id === SHEET_CREATE)).toBe(false);
  });

  it('a page-number endpoint (the card says page) sends page 2, 3…', async () => {
    const h = harness({
      answer: (_id, _args, n) => ({ ok: true, credits: 1, data: { posts: [post(`p${n}`)] } }),
      card: { 'svc:instagram.search_hashtag': { paging: { how: 'page', field: 'page' } } },
    });
    await h.svc.run('r', job({ 'svc:instagram.search_hashtag': { hashtag: 'smarthome', _pages: 3 } }));
    const fetches = h.calls.filter((c) => c.id === 'svc:instagram.search_hashtag');
    expect(fetches.map((f) => f.ctx.args)).toEqual([{ hashtag: 'smarthome' }, { hashtag: 'smarthome', page: 2 }, { hashtag: 'smarthome', page: 3 }]);
  });
});

describe('creators-first', () => {
  const now = Date.now();
  const creatorsJob = (over: any = {}) => job({
    'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 3 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, args: { trim: true }, keepDays: 30, ...over.then }, ...over.block },
  }, over.job);
  const finder = { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Search Instagram Profiles', data: { success: true, profiles: [{ id: '1', username: 'alpha' }, { id: '2', username: 'beta' }, { id: '3', username: 'gamma' }, { id: '4', username: 'delta' }] } };

  it('finder once, one call per creator with the mapped handle (+ fixed args), keepDays applied on the card\'s date field, a creator column, counts + credits', async () => {
    const h = harness({
      answer: (id, args) => {
        if (id === 'svc:instagram.search_profiles') return finder;
        const who = args.handle;
        return { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Posts', data: { items: [
          { id: `${who}-new`, taken_at: Math.floor((now - 2 * day) / 1000), caption: 'fresh' },
          { id: `${who}-old`, taken_at: Math.floor((now - 90 * day) / 1000), caption: 'stale' },
        ], next_max_id: 'x' } };
      },
      card: { 'svc:instagram.user_posts': { fields: [{ path: 'items[].taken_at', kind: 'date' }], paging: { how: 'cursor', field: 'next_max_id' } } },
    });
    await h.svc.run('run1', creatorsJob());
    const finds = h.calls.filter((c) => c.id === 'svc:instagram.search_profiles');
    const posts = h.calls.filter((c) => c.id === 'svc:instagram.user_posts');
    expect(finds).toHaveLength(1);
    expect(finds[0].ctx.args).toEqual({ query: 'smart home india' });
    expect(posts.map((p) => p.ctx.args)).toEqual([{ trim: true, handle: 'alpha' }, { trim: true, handle: 'beta' }, { trim: true, handle: 'gamma' }]); // take 3 of 4
    // the ceiling before every call: finder + 3 creators
    expect(h.budgetChecks).toEqual(['svc:instagram.search_profiles', 'svc:instagram.user_posts', 'svc:instagram.user_posts', 'svc:instagram.user_posts']);
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    const header: string[] = write.args.values[0];
    expect(header).toContain('creator');
    expect(write.args.values).toHaveLength(1 + 3); // only the fresh post of each creator
    const creatorCol = header.indexOf('creator');
    expect(write.args.values.slice(1).map((r: any[]) => r[creatorCol])).toEqual(['alpha', 'beta', 'gamma']);
    expect(h.steps.some((s) => s.label === '4 creators found · taking the first 3 · 1 credit')).toBe(true);
    expect(h.steps.some((s) => s.label === '3 creators · fetched posts for 3 · 3 kept from the last 30 days (of 6) · 4 credits' && s.nodeId === 'src:svc:instagram.search_profiles')).toBe(true);
    expect(h.finish[0].status).toBe('done');
  });

  it('one failing creator is said and skipped; the run finishes done with the others', async () => {
    const h = harness({
      answer: (id, args) => {
        if (id === 'svc:instagram.search_profiles') return finder;
        if (args.handle === 'beta') return { ok: false, credits: 0, error: 'Instagram could not do that: user not found', serviceName: 'Instagram' };
        return { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Posts', data: { items: [{ id: `${args.handle}-1`, taken_at: Math.floor(now / 1000) }] } };
      },
    });
    await h.svc.run('run1', creatorsJob());
    expect(h.finish[0].status).toBe('done');
    const s = h.steps.find((x) => /fetched posts for 2/.test(x.label));
    expect(s.label).toBe('3 creators · fetched posts for 2 · 1 failed and was skipped · 2 kept from the last 30 days (of 2) · 3 credits');
    expect(s.detail).toMatch(/beta: .*user not found/);
  });

  it('the date field is decided over EVERY creator\'s items — an empty first answer (`{items:[]}`, or a private account\'s `{user, more_available:false}` with no list at all) is 0 items and does not switch the days filter off (found live)', async () => {
    const { itemsOf } = await import('./social-agent-run.service');
    expect(itemsOf({ items: [], user: { pk: '1' }, more_available: false })).toEqual([]);
    expect(itemsOf({ items: null, user: { pk: '1' } })).toEqual([]);
    expect(itemsOf({ user: { pk: '1', username: 'x' } })).toEqual([{ pk: '1', username: 'x' }]); // a profile lookup as the per-creator action — unwrapped to the profile itself (BEA-1377)
    expect(itemsOf({ items: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    const h = harness({
      answer: (id, args) => {
        if (id === 'svc:instagram.search_profiles') return finder;
        if (args.handle === 'alpha') return { ok: true, credits: 1, actionName: 'Posts', data: { items: null, user: { pk: '1', username: 'alpha' }, more_available: false } };
        return { ok: true, credits: 1, actionName: 'Posts', data: { items: [{ id: `${args.handle}-old`, taken_at: Math.floor((now - 400 * day) / 1000) }, { id: `${args.handle}-new`, taken_at: Math.floor(now / 1000) }] } };
      },
    });
    await h.svc.run('run1', creatorsJob());
    expect(h.steps.some((s) => /2 kept from the last 30 days \(of 4\)/.test(s.label))).toBe(true);
  });

  it('items with no date: everything is kept and the step says the days could not be applied; every creator failing → an empty source, not a failed run', async () => {
    const h = harness({
      answer: (id) => id === 'svc:instagram.search_profiles' ? finder : { ok: true, credits: 1, actionName: 'Posts', data: { items: [{ id: Math.random().toString(36), caption: 'undated' }] } },
    });
    await h.svc.run('run1', creatorsJob());
    expect(h.steps.some((s) => /3 items — these carry no date, so all were kept \(last 30 days could not be applied\)/.test(s.label))).toBe(true);
    expect(h.finish[0].status).toBe('done');
    const all = harness({ answer: (id) => id === 'svc:instagram.search_profiles' ? finder : { ok: false, credits: 0, error: 'boom' } });
    await all.svc.run('run1', creatorsJob());
    expect(all.finish[0].status).toBe('done');
    expect(all.finish[0].resultText).toMatch(/0 results found — nothing to write/);
    expect(all.calls.some((c) => c.id === SHEET_CREATE)).toBe(false);
  });

  it('BEA-1373: creators fetched but NOTHING kept from the window → an empty source with THAT reason; the summary names every empty source and its own why (the first live run said "all 4 sources answered not_found" over a 5-source plan)', async () => {
    const HASHTAG = 'svc:instagram.search_hashtag';
    const NOT_FOUND = { ok: false, error: 'Instagram could not do that: No posts found', credits: 0, status: 404, notFound: true, serviceName: 'Instagram', actionName: 'Search Hashtag Posts' };
    const h = harness({
      answer: (id, args) => {
        if (id === HASHTAG) return NOT_FOUND;
        if (id === 'svc:instagram.search_profiles') return finder;
        return { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Posts', data: { items: [{ id: `${args.handle}-old`, taken_at: Math.floor((now - 90 * day) / 1000), caption: 'stale' }] } };
      },
      card: { 'svc:instagram.user_posts': { fields: [{ path: 'items[].taken_at', kind: 'date' }] } },
    });
    await h.svc.run('run1', job({
      [HASHTAG]: { actionId: HASHTAG, args: { hashtag: 'smarthomeindia', date_posted: 'last-month' } },
      [`${HASHTAG}#2`]: { actionId: HASHTAG, args: { hashtag: 'homeautomationindia', date_posted: 'last-month' } },
      'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home india' }, take: 3 }, then: { actionId: 'svc:instagram.user_posts', argsFrom: { handle: 'username' }, keepDays: 30 } },
    }, { notifyWhatsApp: true }));
    expect(h.finish[0].status).toBe('done');
    const text: string = h.finish[0].resultText;
    expect(text).toMatch(/0 posts found — nothing to write, no sheet made \(all 3 sources came back empty\)/);
    expect(text).not.toMatch(/all 3 sources answered not_found/); // the creators block did NOT answer not_found
    expect(text).not.toMatch(/no creator's fetch succeeded/); // every fetch succeeded — the posts were just old
    expect(text).toMatch(/smarthomeindia — no posts found \(vendor answered not_found\)/);
    expect(text).toMatch(/homeautomationindia — no posts found \(vendor answered not_found\)/);
    expect(text).toMatch(/3 creators · 0 kept from the last 30 days \(of 3\)/);
    expect(h.calls.some((c) => c.id === SHEET_CREATE)).toBe(false); // nothing written, nothing sent
  });

  it('BEA-1373: a Watch with a creators block that kept nothing still goes through the watch path (baseline, "watching from now"), not the run-mode "nothing to write" summary', async () => {
    const h = harness({
      answer: (id, args) => id === 'svc:instagram.search_profiles' ? finder : { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Posts', data: { items: [{ id: `${args.handle}-old`, taken_at: Math.floor((now - 90 * day) / 1000), caption: 'stale' }] } },
      card: { 'svc:instagram.user_posts': { fields: [{ path: 'items[].taken_at', kind: 'date' }] } },
    });
    const watches = { get: jest.fn(async () => null), save: jest.fn(async () => undefined) };
    (h.svc as any).watches = watches;
    await h.svc.run('run1', creatorsJob({ job: { mode: 'watch' } }));
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).not.toMatch(/nothing to write, no sheet made/);
    expect(watches.save).toHaveBeenCalled(); // the baseline is stored — the watch keeps its 0-item table
    expect(h.steps.some((s) => /0 kept from the last 30 days \(of 3\)/.test(s.label))).toBe(true);
  });

  it('BEA-1373: the run SAYS the AI tokens its shaping step really spent, on the shape step and in the result — next to the credits', async () => {
    const h = harness({ answer: () => ({ ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Popular Search', data: { posts: [post('a'), post('b')] } }) });
    (h.svc as any).llm.tokensSince = jest.fn(async (feature: string) => (feature === 'social-shape' ? 38412 : 0));
    await h.svc.run('run1', job({ 'svc:instagram.search_popular': { actionId: 'svc:instagram.search_popular', args: { query: 'smart home india' } } }, { prompt: 'Keep only India posts. Columns: link, caption.' }));
    expect(h.finish[0].status).toBe('done');
    expect(h.steps.some((s) => s.nodeId === 'shape' && /Shaped 1 row into 2 columns · 38k AI tokens/.test(s.label))).toBe(true);
    expect(h.finish[0].resultText).toMatch(/\*\*1 row\*\* · 1 credit · 38k AI tokens/);
    // no shaping (rows as fetched) → no AI tokens claimed
    const plain = harness({ answer: () => ({ ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Popular Search', data: { posts: [post('a')] } }) });
    await plain.svc.run('run1', job({ 'svc:instagram.search_popular': { actionId: 'svc:instagram.search_popular', args: { query: 'x' } } }));
    expect(plain.finish[0].resultText).not.toMatch(/AI tokens/);
  });

  it('a creators-first source without a per-creator action fails the run plainly; a finder not_found is an empty source', async () => {
    const h = harness({ answer: () => finder });
    await h.svc.run('run1', creatorsJob({ then: { actionId: '' } }));
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/no per-creator action/);
    const e = harness({ answer: () => ({ ok: false, notFound: true, credits: 0, error: 'not_found', serviceName: 'Instagram', actionName: 'Search Instagram Profiles' }) });
    await e.svc.run('run1', creatorsJob());
    expect(e.finish[0].status).toBe('done');
    expect(e.steps.some((s) => /no creators found \(vendor answered not_found\)/.test(s.label))).toBe(true);
  });

  // BEA-1377 — the owner's live run: find profiles → the full profile per account. The per-creator
  // answer is ONE object under `data.user`, and 101 succeeded calls were counted as "0 items".
  describe('BEA-1377: a single-object per-creator answer is ONE row', () => {
    const profileJob = (over: any = {}) => job({
      'svc:instagram.search_profiles': { kind: 'creators', find: { actionId: 'svc:instagram.search_profiles', args: { query: 'smart home' }, take: 3 }, then: { actionId: 'svc:instagram.profile', argsFrom: { handle: 'username' }, ...over.then } },
    }, over.job);
    const profileAnswer = (who: string) => ({
      ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Get Instagram Profile',
      // the live shape: the profile under data.user, envelope around it (run f76834e7)
      data: { success: true, credits_charged: 1, data: { user: { pk: `pk-${who}`, id: `id-${who}`, username: who, full_name: `${who} Homes`, biography: `${who} builds smart homes`, follower_count: 12345, is_verified: false } } },
    });

    it("the owner's shape: find search_profiles → profile (handle ← username) → 3 found → 3 rows with username/biography/follower_count and a creator column", async () => {
      const h = harness({ answer: (id, args) => (id === 'svc:instagram.search_profiles' ? finder : profileAnswer(args.handle)) });
      await h.svc.run('run1', profileJob());
      expect(h.finish[0].status).toBe('done');
      const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
      const header: string[] = write.args.values[0];
      expect(write.args.values).toHaveLength(1 + 3); // one row per creator — never 0
      for (const col of ['creator', 'username', 'biography', 'follower_count']) expect(header).toContain(col);
      const at = (row: any[], col: string) => row[header.indexOf(col)];
      expect(write.args.values.slice(1).map((r: any[]) => at(r, 'username'))).toEqual(['alpha', 'beta', 'gamma']);
      expect(write.args.values.slice(1).map((r: any[]) => at(r, 'creator'))).toEqual(['alpha', 'beta', 'gamma']);
      expect(at(write.args.values[1], 'biography')).toBe('alpha builds smart homes');
      expect(at(write.args.values[1], 'follower_count')).toBe(12345);
      // honest wording: profiles fetched · rows — never "0 items"
      expect(h.steps.some((s) => s.label === '3 profiles fetched · 3 rows · 4 credits' && s.nodeId === 'src:svc:instagram.search_profiles')).toBe(true);
      expect(h.finish[0].resultText).toMatch(/\*\*3 rows\*\*/);
    });

    it('keepDays on a profile (no date field): everything kept, said once per source — never silently dropped', async () => {
      const h = harness({ answer: (id, args) => (id === 'svc:instagram.search_profiles' ? finder : profileAnswer(args.handle)) });
      await h.svc.run('run1', profileJob({ then: { keepDays: 30 } }));
      expect(h.finish[0].status).toBe('done');
      expect(h.steps.some((s) => s.label === '3 profiles fetched · 3 rows — these carry no date, so all were kept (last 30 days could not be applied) · 4 credits')).toBe(true);
      const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
      expect(write.args.values).toHaveLength(1 + 3);
    });

    it('the tripwire: calls succeeded with data but 0 rows recognised → the step says it is a My Brain bug, not the vendor; the run still finishes honestly', async () => {
      const h = harness({
        answer: (id) => (id === 'svc:instagram.search_profiles' ? finder : { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Get Instagram Profile', data: { success: true, weird_numbers: [1, 2, 3] } }),
      });
      await h.svc.run('run1', profileJob());
      expect(h.finish[0].status).toBe('done');
      expect(h.steps.some((s) => /fetched 3 answers but recognised 0 rows — this is a My Brain bug, not the vendor/i.test(s.label))).toBe(true);
      expect(h.finish[0].resultText).toMatch(/My Brain bug, not the vendor/);
      expect(h.calls.some((c) => c.id === SHEET_CREATE)).toBe(false); // nothing invented
    });

    it('itemsOf: the live envelope {success, credits_charged, data:{user}} unwraps to ONE profile row', async () => {
      const { itemsOf, unrecognisedAnswer } = await import('./social-agent-run.service');
      expect(itemsOf({ success: true, credits_charged: 1, data: { user: { pk: '1', username: 'x', biography: 'b' } } })).toEqual([{ pk: '1', username: 'x', biography: 'b' }]);
      expect(itemsOf({ success: true })).toEqual([]); // envelope only — never a row of nothing
      // list answers keep behaving as before
      expect(itemsOf({ items: null, user: { pk: '1' }, more_available: false })).toEqual([]);
      expect(itemsOf({ items: [{ id: 1 }] })).toEqual([{ id: 1 }]);
      // the tripwire's judge: an unreadable payload is unrecognised; an empty list on purpose is not
      expect(unrecognisedAnswer({ success: true, weird_numbers: [1, 2, 3] })).toBe(true);
      expect(unrecognisedAnswer({ items: null, user: { pk: '1' }, more_available: false })).toBe(false);
      expect(unrecognisedAnswer({ items: [] })).toBe(false);
      expect(unrecognisedAnswer({ success: true })).toBe(false);
      expect(unrecognisedAnswer({ success: true, credits_charged: 1, data: { user: { pk: '1' } } })).toBe(false); // recognised → one row, not a bug
      // review fixes: a stray null list-named key BESIDE the data wrapper never hides the profile…
      expect(itemsOf({ success: true, data: { user: { pk: '1', username: 'x' } }, comments: null })).toEqual([{ pk: '1', username: 'x' }]);
      expect(unrecognisedAnswer({ success: true, data: { user: { pk: '1' } }, comments: null })).toBe(false);
      // …and the vendor's own "no such account" (`data.user: null`) is the vendor's empty, not our bug
      expect(itemsOf({ success: true, data: { user: null } })).toEqual([]);
      expect(unrecognisedAnswer({ success: true, data: { user: null } })).toBe(false);
      expect(unrecognisedAnswer({ success: true, data: { weird_numbers: [1, 2, 3] } })).toBe(true); // unreadable inside the wrapper is still our bug
    });

    it('partial loss is never silent: some answers read, some unrecognised → the step names the dropped count as a My Brain bug', async () => {
      const h = harness({
        answer: (id, args) => {
          if (id === 'svc:instagram.search_profiles') return finder;
          if (args.handle === 'gamma') return { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Get Instagram Profile', data: { success: true, weird_numbers: [1, 2, 3] } };
          return profileAnswer(args.handle);
        },
      });
      await h.svc.run('run1', profileJob());
      expect(h.finish[0].status).toBe('done');
      expect(h.steps.some((s) => /2 items · 4 credits · 1 answer carried data but no rows were recognised — a My Brain bug, not the vendor/.test(s.label))).toBe(true);
      const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
      expect(write.args.values).toHaveLength(1 + 2); // the two readable profiles still land
    });
  });

  it('a creators-first block beside a plain source: merged under a source column, both nodes badged', async () => {
    const h = harness({
      answer: (id, args) => {
        if (id === 'svc:instagram.search_profiles') return finder;
        if (id === 'svc:instagram.user_posts') return { ok: true, credits: 1, actionName: 'Posts', data: { items: [{ id: `${args.handle}-1`, caption: 'c' }] } };
        return { ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Popular Search', data: { posts: [post('pop1')] } };
      },
    });
    const j = creatorsJob();
    j.toolArgs['svc:instagram.search_popular'] = { query: 'homeautomation' };
    j.tools = ['svc:instagram.search_popular', 'svc:instagram.search_profiles'];
    await h.svc.run('run1', j);
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.values[0][0]).toBe('source');
    expect(write.args.values.slice(1).map((r: any[]) => r[0])).toEqual(['instagram.search_popular', 'instagram.search_profiles', 'instagram.search_profiles', 'instagram.search_profiles']);
    expect(h.steps.some((s) => s.nodeId === 'src:svc:instagram.search_popular')).toBe(true);
    expect(h.steps.some((s) => s.nodeId === 'src:svc:instagram.search_profiles')).toBe(true);
    expect(h.steps.some((s) => /Merged 2 sources into 4 rows/.test(s.label))).toBe(true);
  });
});

describe('run() goes through the plan', () => {
  it('run(agent) and runPlan(planFromAgent(agent)) make the same calls', async () => {
    const mk = () => harness({ answer: (_id, _args, n) => ({ ok: true, credits: 1, data: { cursor: n < 2 ? 'c' : null, posts: [post(`p${n}`)] } }) });
    const a = mk();
    const b = mk();
    const j = job({ 'svc:instagram.search': { query: 'q', _pages: 2 } });
    await a.svc.run('r', j);
    await b.svc.runPlan('r', j, planFromAgent(j));
    expect(a.calls.map((c) => [c.id, c.ctx.args])).toEqual(b.calls.map((c) => [c.id, c.ctx.args]));
    expect(a.steps.map((s) => s.label)).toEqual(b.steps.map((s) => s.label));
  });
});
