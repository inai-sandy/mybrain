import { KEEP_AS_FETCHED, SHAPE_BATCH, SHAPE_MAX_TOKENS, SHEET_CREATE, SHEET_READ, SHEET_WRITE, SocialAgentRunService, colLetter, dropSeenRows, isEmptySearch, keyColumnIndex, mergeTables, nounOf, salvageRowsJson, shapeInput } from './social-agent-run.service';

/**
 * BEA-1357 — a Social agent's run: direct fetch (no engine turn), rows → a Google Sheet through the
 * seam (create, or append), the not-connected refusal, and the WhatsApp "no number" message.
 */

const POSTS = { success: true, credits_charged: 1, posts: [{ url: 'u1', caption: 'Smart home India', like_count: 3, owner: { username: 'a' } }, { url: 'u2', caption: 'Elsewhere', like_count: 5, owner: { username: 'b' } }] };

function harness(opts: { fetchOk?: boolean; sheets?: 'ok' | 'not-connected'; existing?: { count: number; header: string[]; keyValues?: string[] } | null; whatsapp?: { sent: boolean; why?: string; via?: 'template' | 'text'; error?: string; note?: string } | null; shapeReply?: string | null; docs?: boolean; perTool?: Record<string, any>; byArgs?: (id: string, args: any) => any } = {}) {
  const steps: any[] = [];
  const finish: any[] = [];
  const calls: { id: string; ctx: any }[] = [];
  const agent = {
    appendStep: jest.fn(async (_id: string, s: any) => { steps.push(s); }),
    finishRun: jest.fn(async (_id: string, p: any) => { finish.push(p); }),
    attachOutput: jest.fn(async () => undefined),
    updateAgent: jest.fn(async () => ({})), // "keep adding" remembers the first run's sheet on the job (BEA-1374)
  };
  const actions = {
    runDetailed: jest.fn(async (id: string, _input: string, ctx: any) => {
      calls.push({ id, ctx });
      if (opts.perTool && id in opts.perTool) return opts.perTool[id]; // one answer per tool (BEA-1359)
      if (opts.byArgs && id.startsWith('svc:instagram.')) { const a = opts.byArgs(id, ctx?.args); if (a) return a; } // one answer per (tool, args) (BEA-1374)
      if (id.startsWith('svc:instagram.')) {
        return opts.fetchOk === false
          ? { ok: false, error: 'Instagram could not do that: No posts found', credits: 0, serviceName: 'Instagram', actionName: 'Search' }
          : { ok: true, data: POSTS, credits: 1, serviceName: 'Instagram', actionName: 'Search' };
      }
      if (opts.sheets === 'not-connected') return { ok: false, error: 'Connect Google Sheets first — open /tools, connect it, then run this step again.', serviceName: 'Google Sheets' };
      if (id === SHEET_CREATE) return { ok: true, data: { spreadsheetId: 'SHEET_NEW' } };
      if (id === SHEET_READ) {
        const ex = opts.existing;
        const ranges: string[] = ctx?.args?.ranges || [];
        // The key-column read (BEA-1374): one range, `Sheet1!<col>:<col>` → the header cell + the values.
        if (ranges.length === 1 && /^Sheet1![A-Z]+:[A-Z]+$/.test(ranges[0])) {
          const col = ranges[0].split('!')[1].split(':')[0];
          const at = col.charCodeAt(0) - 65;
          return { ok: true, data: { valueRanges: [{ values: [[ex?.header?.[at] || ''], ...(ex?.keyValues || []).map((v) => [v])] }] } };
        }
        return { ok: true, data: { valueRanges: [{ values: Array.from({ length: ex?.count || 0 }, () => ['x']) }, ...(ex?.header?.length ? [{ values: [ex.header] }] : [{}])] } };
      }
      if (id === SHEET_WRITE) return { ok: true, data: { totalUpdatedRows: 3 } };
      return { ok: false, error: `unknown ${id}` };
    }),
  };
  const llm = { completeHelper: jest.fn(async () => opts.shapeReply === undefined ? '{"columns":["creator","link"],"rows":[["a","u1"]]}' : opts.shapeReply) };
  const documents = opts.docs === false ? undefined : { create: jest.fn(async () => ({ id: 'doc1' })) };
  const alerts = { runFinished: jest.fn(async () => opts.whatsapp || { sent: true }), runFailed: jest.fn(async () => ({ sent: false })) };
  const svc = new SocialAgentRunService(agent as any, actions as any, llm as any, documents as any, alerts as any, undefined);
  return { svc, steps, finish, calls, agent, actions, llm, documents, alerts };
}

const job = (over: any = {}) => ({ id: 'ag1', name: 'Instagram · Search · smarthomeindia', prompt: KEEP_AS_FETCHED, tools: ['svc:instagram.search'], toolArgs: { 'svc:instagram.search': { query: 'smarthomeindia' } }, outputDest: 'sheet', sheetId: null, notifyWhatsApp: false, ...over });

describe('SocialAgentRunService.handles', () => {
  const { svc } = harness();
  it('takes a job whose tools are all svc: ids with pinned arguments, and nothing else', () => {
    expect(svc.handles(job())).toBe(true);
    expect(svc.handles(job({ toolArgs: null }))).toBe(false); // no arguments → not ours to guess
    expect(svc.handles(job({ tools: ['web_search'] }))).toBe(false);
    expect(svc.handles(job({ tools: ['svc:instagram.search', 'svc:x.y'] }))).toBe(false); // one tool without args
    expect(svc.handles(job({ tools: [] }))).toBe(false);
  });
  it('shaping runs only when the task says more than "as fetched"', () => {
    expect(svc.wantsShaping(KEEP_AS_FETCHED)).toBe(false);
    expect(svc.wantsShaping('keep every result as fetched')).toBe(false);
    expect(svc.wantsShaping('')).toBe(false);
    expect(svc.wantsShaping('Only posts about India. Columns: creator, link')).toBe(true);
  });
});

describe('SocialAgentRunService.run — the fetch is direct and recorded', () => {
  it('fetches through runDetailed with the pinned args, runKind agent, argsPinned — never a model fill, never an engine turn', async () => {
    const h = harness();
    await h.svc.run('run1', job());
    const fetch = h.calls.find((c) => c.id === 'svc:instagram.search')!;
    expect(fetch.ctx).toMatchObject({ runId: 'run1', runKind: 'agent', agentId: 'ag1', argsPinned: true, args: { query: 'smarthomeindia' } });
    // the ONLY model call this path may make is the shaping step, and the task did not ask for it
    expect(h.llm.completeHelper).not.toHaveBeenCalled();
    expect(h.finish[0].status).toBe('done');
    // credits are said on the run
    expect(h.steps.some((s) => /1 credit/.test(s.label))).toBe(true);
  });

  it('a failed fetch fails the run with the provider\'s reason — never a run that says done', async () => {
    const h = harness({ fetchOk: false });
    await h.svc.run('run1', job());
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/No posts found/);
    expect(h.calls.some((c) => c.id === SHEET_CREATE)).toBe(false); // no sheet for nothing
  });
});

describe('outputDest sheet — create, then write at A1', () => {
  it('creates a Google Sheet through the seam, writes header + rows from A1, links the run to the BUILT url', async () => {
    const h = harness();
    await h.svc.run('run1', job());
    const ids = h.calls.map((c) => c.id);
    expect(ids).toEqual(['svc:instagram.search', SHEET_CREATE, SHEET_WRITE]);
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.spreadsheet_id).toBe('SHEET_NEW');
    expect(write.args.first_cell_location).toBe('A1');
    expect(write.args.sheet_name).toBe('Sheet1');
    expect(write.args.values[0]).toEqual(expect.arrayContaining(['caption', 'url', 'like_count', 'owner_username'])); // header
    expect(write.args.values).toHaveLength(3); // header + 2 rows
    // every sheet call rides on THIS run, so ToolCall rows point back at it
    for (const c of h.calls) expect(c.ctx).toMatchObject({ runId: 'run1', runKind: 'agent', argsPinned: true });
    expect(h.finish[0]).toMatchObject({ status: 'done', outputUrl: 'https://docs.google.com/spreadsheets/d/SHEET_NEW' });
    expect(h.finish[0].resultText).toContain('https://docs.google.com/spreadsheets/d/SHEET_NEW');
    // no Document was made — the sheet IS the output
    expect(h.documents!.create).not.toHaveBeenCalled();
  });

  it('append mode: reads the sheet first, keeps ITS header order, writes from the first free row', async () => {
    const h = harness({ existing: { count: 4, header: ['url', 'caption'], keyValues: ['u9', 'u8', 'u7'] } });
    await h.svc.run('run1', job({ sheetId: 'SHEET_OLD' }));
    const ids = h.calls.map((c) => c.id);
    // no create; the header has a key column (`url`), so its values are read too (BEA-1374 de-dupe)
    expect(ids).toEqual(['svc:instagram.search', SHEET_READ, SHEET_READ, SHEET_WRITE]);
    const read = h.calls.find((c) => c.id === SHEET_READ)!.ctx;
    expect(read.args).toEqual({ spreadsheet_id: 'SHEET_OLD', ranges: ['Sheet1!A:A', 'Sheet1!1:1'] });
    expect(h.calls[2].ctx.args).toEqual({ spreadsheet_id: 'SHEET_OLD', ranges: ['Sheet1!A:A'] }); // `url` is column A
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.spreadsheet_id).toBe('SHEET_OLD');
    expect(write.args.first_cell_location).toBe('A5'); // 4 rows already there
    expect(write.args.values).toEqual([['u1', 'Smart home India'], ['u2', 'Elsewhere']]); // sheet's own columns, no header again
    expect(h.finish[0].outputUrl).toBe('https://docs.google.com/spreadsheets/d/SHEET_OLD');
    expect(h.steps.some((s) => /Appended 2 rows/.test(s.label))).toBe(true);
  });

  it('append to a still-empty sheet: header + rows from A1', async () => {
    const h = harness({ existing: { count: 0, header: [] } });
    await h.svc.run('run1', job({ sheetId: 'SHEET_EMPTY' }));
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.first_cell_location).toBe('A1');
    expect(write.args.values).toHaveLength(3);
  });

  it('Sheets not connected → the run FAILS with "Connect Google Sheets first" and the /tools door — never a silent skip', async () => {
    const h = harness({ sheets: 'not-connected' });
    await h.svc.run('run1', job());
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/^Connect Google Sheets first/);
    expect(h.finish[0].error).toContain('/tools');
    expect(h.finish[0].outputUrl).toBeUndefined();
  });

  it('a pasted sheet URL was already cleaned to an id by AgentService — the runner is handed an id', async () => {
    const h = harness({ existing: { count: 1, header: ['url'] } });
    await h.svc.run('run1', job({ sheetId: 'ID_ONLY' }));
    expect(h.calls.find((c) => c.id === SHEET_READ)!.ctx.args.spreadsheet_id).toBe('ID_ONLY');
  });
});

describe('outputDest document (the default) still lands in Documents', () => {
  it('saves a markdown table and attaches it to the run', async () => {
    const h = harness();
    await h.svc.run('run1', job({ outputDest: 'document' }));
    expect(h.documents!.create).toHaveBeenCalledTimes(1);
    expect(h.agent.attachOutput).toHaveBeenCalledWith('run1', 'doc1');
    expect(h.finish[0]).toMatchObject({ status: 'done', outputDocId: 'doc1' });
    expect(h.calls.some((c) => c.id.startsWith('svc:googlesheets'))).toBe(false);
  });
});

describe('the shaping step (columns · a filter like "in India")', () => {
  it('runs on the social-shape helper only when the task asks, and its columns become the sheet', async () => {
    const h = harness();
    await h.svc.run('run1', job({ prompt: 'Only posts about India. Columns: creator, link' }));
    expect(h.llm.completeHelper).toHaveBeenCalledTimes(1);
    expect((h.llm.completeHelper as jest.Mock).mock.calls[0][0]).toBe('social-shape');
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.values).toEqual([['creator', 'link'], ['a', 'u1']]);
    expect(h.finish[0].status).toBe('done');
  });
  it('append mode tells the model the sheet\'s own columns', async () => {
    const h = harness({ existing: { count: 2, header: ['creator', 'link'] } });
    await h.svc.run('run1', job({ prompt: 'Only posts about India', sheetId: 'S' }));
    const prompt: string = (h.llm.completeHelper as jest.Mock).mock.calls[0][1];
    expect(prompt).toContain('["creator","link"]');
  });
  it('BEA-1369: a reply CUT OFF mid-row is salvaged to its complete rows; batches are 30 items with a 32k ceiling (a 60-item batch was cut at 12k live)', async () => {
    expect(SHAPE_BATCH).toBe(30);
    expect(SHAPE_MAX_TOKENS).toBeGreaterThanOrEqual(32_000);
    const cut = 'Here you go:\n{"columns":["creator","link","caption"],"rows":[["a","u1","one"],["b","u2","two"],["c","u3","thr';
    expect(salvageRowsJson(cut)).toEqual({ columns: ['creator', 'link', 'caption'], rows: [['a', 'u1', 'one'], ['b', 'u2', 'two']] });
    expect(salvageRowsJson('{"columns":["x"],"rows":[["1"]]}')).toEqual({ columns: ['x'], rows: [['1']] });
    expect(salvageRowsJson('{"columns":["x"],"rows":[["1"],["2"]]} trailing')).toEqual({ columns: ['x'], rows: [['1'], ['2']] });
    expect(salvageRowsJson('no json here')).toBeNull();
    expect(salvageRowsJson('{"columns":["x"],"rows":[["never clo')).toEqual({ columns: ['x'], rows: [] }); // nothing complete → 0 rows, not a crash
    // through the run: the cut reply still writes the two complete rows
    const h = harness({ shapeReply: cut });
    await h.svc.run('run1', job({ prompt: 'Only posts about India. Columns: creator, link, caption' }));
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.values).toEqual([['creator', 'link', 'caption'], ['a', 'u1', 'one'], ['b', 'u2', 'two']]);
    expect(h.finish[0].status).toBe('done');
    // the ceiling asked for is the new one
    expect((h.llm.completeHelper as jest.Mock).mock.calls[0][2]).toBe(SHAPE_MAX_TOKENS);
  });

  it('a shaping model that answers nothing fails the run — a run may never say done if a step failed', async () => {
    const h = harness({ shapeReply: null });
    await h.svc.run('run1', job({ prompt: 'Only posts about India' }));
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/Could not shape the rows/);
    expect(h.calls.some((c) => c.id === SHEET_CREATE)).toBe(false);
  });
});

describe('WhatsApp — the link goes through AlertsService.runFinished, and silence is said', () => {
  it('sends the sheet link when the job asks and a number is set', async () => {
    const h = harness({ whatsapp: { sent: true, via: 'template' } });
    await h.svc.run('run1', job({ notifyWhatsApp: true }));
    expect(h.alerts.runFinished).toHaveBeenCalledTimes(1);
    const [name, headline, path] = (h.alerts.runFinished as jest.Mock).mock.calls[0];
    expect(name).toBe('Instagram · Search · smarthomeindia');
    expect(headline).toContain('https://docs.google.com/spreadsheets/d/SHEET_NEW');
    expect(path).toBe('/agent/runs/run1');
    // The step is the template's own verdict — never "accepted for delivery" (BEA-1362).
    expect(h.steps.some((s) => s.label === 'WhatsApp sent (template)')).toBe(true);
    expect(h.steps.some((s) => /accepted for delivery/.test(s.label))).toBe(false);
  });
  it("Meta refused the template → the step says 'WhatsApp failed' with Meta's reason (BEA-1362)", async () => {
    const h = harness({ whatsapp: { sent: false, via: 'template', error: "That message template isn't approved yet", why: "That message template isn't approved yet" } });
    await h.svc.run('run1', job({ notifyWhatsApp: true }));
    expect(h.steps.some((s) => /WhatsApp failed: That message template isn't approved yet/.test(s.label))).toBe(true);
    expect(h.finish[0].status).toBe('done');
  });
  it('no number in Settings → the run shows "no WhatsApp number in Settings"', async () => {
    const h = harness({ whatsapp: { sent: false, why: 'no number' } });
    await h.svc.run('run1', job({ notifyWhatsApp: true }));
    expect(h.steps.some((s) => /no WhatsApp number in Settings/.test(s.label))).toBe(true);
    expect(h.finish[0].status).toBe('done'); // the sheet exists; the message is what failed, and it says so
  });
  it('WhatsApp off on the job → nothing is sent and nothing is claimed', async () => {
    const h = harness();
    await h.svc.run('run1', job({ notifyWhatsApp: false }));
    expect(h.alerts.runFinished).not.toHaveBeenCalled();
    expect(h.steps.some((s) => /WhatsApp/.test(s.label))).toBe(false);
  });
});

describe('several tools in one job → one table with a source column', () => {
  it('unions the columns and says which tool each row came from', () => {
    const m = mergeTables([
      { id: 'svc:instagram.search', table: { columns: ['url', 'caption'], rows: [['u1', 'a']], itemCount: 1 } },
      { id: 'svc:tiktok.search', table: { columns: ['url', 'views'], rows: [['t1', 9]], itemCount: 1 } },
    ]);
    expect(m.columns).toEqual(['source', 'url', 'caption', 'views']);
    expect(m.rows).toEqual([['instagram.search', 'u1', 'a', ''], ['tiktok.search', 't1', '', 9]]);
    expect(m.itemCount).toBe(2);
    expect(m.dedupe).toEqual({ column: 'url', dropped: 0 });
  });
  it('BEA-1374: a post two sources both found is ONE row (de-duped on the id column); rows with no id are kept; no id column → no de-dupe', () => {
    const m = mergeTables([
      { id: 'instagram.search_hashtag · a', table: { columns: ['shortcode', 'caption'], rows: [['s1', 'x'], ['s2', 'y'], ['', 'no id']], itemCount: 3 } },
      { id: 'instagram.search_hashtag · b', table: { columns: ['shortcode', 'caption'], rows: [['s2', 'y again'], ['s3', 'z'], ['', 'no id 2']], itemCount: 3 } },
    ]);
    expect(m.rows.map((r) => r.slice(0, 2))).toEqual([['instagram.search_hashtag · a', 's1'], ['instagram.search_hashtag · a', 's2'], ['instagram.search_hashtag · a', ''], ['instagram.search_hashtag · b', 's3'], ['instagram.search_hashtag · b', '']]);
    expect(m.dedupe).toEqual({ column: 'shortcode', dropped: 1 });
    const n = mergeTables([{ id: 'a', table: { columns: ['caption'], rows: [['x']], itemCount: 1 } }, { id: 'b', table: { columns: ['caption'], rows: [['x']], itemCount: 1 } }]);
    expect(n.rows).toHaveLength(2);
    expect(n.dedupe).toBeUndefined();
  });
});

/**
 * BEA-1374 — sources are keyed by SOURCE id: five hashtag searches on ONE action run as five sources
 * (each its own arguments and pages, its own node), merged and de-duped; and "keep adding" appends
 * to ONE sheet — made on the first run and remembered on the job, rows already there skipped.
 */
describe('BEA-1374 — five sources on the same action, and "keep adding" means append', () => {
  const HASHTAGS = ['smarthomeindia', 'homeautomationindia', 'smarthome', 'homeautomation', 'smartlighting'];
  const fiveHashtags = (over: any = {}) => {
    const toolArgs: Record<string, any> = {};
    HASHTAGS.forEach((h, i) => { toolArgs[i ? `svc:instagram.search_hashtag#${i + 1}` : 'svc:instagram.search_hashtag'] = { actionId: 'svc:instagram.search_hashtag', args: { hashtag: h }, _pages: 1 }; });
    return job({ id: 'ag5', name: 'Five hashtags', tools: ['svc:instagram.search_hashtag'], toolArgs, ...over });
  };
  // Each hashtag answers two posts; `shared` is found by every hashtag, the other is its own.
  const byArgs = (_id: string, args: any) => ({ ok: true, credits: 1, serviceName: 'Instagram', actionName: 'Search Hashtag Posts', data: { success: true, posts: [{ shortcode: 'shared', caption: 'in every search' }, { shortcode: `own-${args.hashtag}`, caption: `#${args.hashtag}` }] } });

  it('runs all five sources — five direct fetches with their own hashtag, five node ids — merges them de-duped, writes the sheet, and says "5 sources … de-duped"', async () => {
    const h = harness({ byArgs });
    await h.svc.run('run5', fiveHashtags());
    const fetches = h.calls.filter((c) => c.id === 'svc:instagram.search_hashtag');
    expect(fetches).toHaveLength(5);
    expect(fetches.map((c) => c.ctx.args.hashtag)).toEqual(HASHTAGS);
    for (const c of fetches) expect(c.ctx).toMatchObject({ runId: 'run5', runKind: 'agent', argsPinned: true });
    // one step per source, badged on its own node, naming its hashtag
    const nodeIds = h.steps.filter((s) => /^Fetched Instagram/.test(s.label)).map((s) => s.nodeId);
    expect(nodeIds).toEqual(['src:svc:instagram.search_hashtag', 'src:svc:instagram.search_hashtag#2', 'src:svc:instagram.search_hashtag#3', 'src:svc:instagram.search_hashtag#4', 'src:svc:instagram.search_hashtag#5']);
    expect(h.steps.some((s) => /Fetched Instagram · Search Hashtag Posts \(smarthomeindia\)/.test(s.label))).toBe(true);
    // merged: 10 rows fetched, the shared post kept once → 6 rows, and the step says so
    const merge = h.steps.find((s) => s.nodeId === 'merge')!;
    expect(merge.label).toBe('Merged 5 sources into 6 rows · 4 duplicates across sources dropped (matched on "shortcode")');
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    const values: any[][] = write.args.values;
    expect(values[0]).toEqual(['source', 'caption', 'shortcode']);
    expect(values.slice(1).map((r) => r[0])).toEqual(['instagram.search_hashtag · smarthomeindia', 'instagram.search_hashtag · smarthomeindia', 'instagram.search_hashtag · homeautomationindia', 'instagram.search_hashtag · smarthome', 'instagram.search_hashtag · homeautomation', 'instagram.search_hashtag · smartlighting']);
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/\*\*6 rows\*\* · 5 credits/);
    // no shaping call — the task is "as fetched"; the model is never asked
    expect(h.llm.completeHelper).not.toHaveBeenCalled();
  });

  it('the OLD storage shape (one action = one source) runs exactly as before — same fetch, same source column, same node id', async () => {
    const h = harness();
    await h.svc.run('run1', job({ tools: ['svc:instagram.search', 'svc:instagram.reels_search'], toolArgs: { 'svc:instagram.search': { query: 'a' }, 'svc:instagram.reels_search': { query: 'b' } } }));
    expect(h.calls.filter((c) => c.id.startsWith('svc:instagram.')).map((c) => [c.id, c.ctx.args])).toEqual([['svc:instagram.search', { query: 'a' }], ['svc:instagram.reels_search', { query: 'b' }]]);
    expect(h.steps.filter((s) => /^Fetched/.test(s.label)).map((s) => s.nodeId)).toEqual(['src:svc:instagram.search', 'src:svc:instagram.reels_search']);
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.values.slice(1).map((r: any[]) => r[0])).toEqual(['instagram.search', 'instagram.search', 'instagram.reels_search', 'instagram.reels_search'].slice(0, 2)); // the same 2 posts from both → de-duped on url to the first source's
    expect(h.steps.find((s) => s.nodeId === 'merge')!.label).toMatch(/2 duplicates across sources dropped \(matched on "url"\)/);
  });

  it('"keep adding" (sheetAppend, no sheet yet): the first run CREATES one sheet titled with the job name (no date) and remembers it on the job', async () => {
    const h = harness({ byArgs });
    await h.svc.run('run6', fiveHashtags({ sheetAppend: true, sheetId: null }));
    expect(h.calls.filter((c) => c.id === SHEET_CREATE)).toHaveLength(1);
    expect(h.calls.find((c) => c.id === SHEET_CREATE)!.ctx.args.title).toBe('Five hashtags');
    expect(h.calls.some((c) => c.id === SHEET_READ)).toBe(false); // nothing to read yet
    expect(h.agent.updateAgent).toHaveBeenCalledWith('ag5', { sheetId: 'SHEET_NEW' });
    expect(h.steps.some((s) => /Remembered this sheet on the job/.test(s.label))).toBe(true);
    expect(h.finish[0]).toMatchObject({ status: 'done', outputUrl: 'https://docs.google.com/spreadsheets/d/SHEET_NEW' });
  });

  it('…and if the sheet cannot be remembered, the run FAILS and says what to do — the next run must not make another sheet quietly', async () => {
    const h = harness({ byArgs });
    (h.agent.updateAgent as jest.Mock).mockRejectedValueOnce(new Error('db locked'));
    await h.svc.run('run6', fiveHashtags({ sheetAppend: true, sheetId: null }));
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/could not be remembered on the job \(db locked\)/);
  });

  it('the next run appends to THAT sheet and skips rows already there — matched on the sheet\'s own key column; a new-per-run job (no append) is untouched', async () => {
    const h = harness({ byArgs, existing: { count: 4, header: ['source', 'caption', 'shortcode'], keyValues: ['shared', 'own-smarthome', 'own-smartlighting'] } });
    await h.svc.run('run7', fiveHashtags({ sheetId: 'SHEET_ONE' }));
    const ids = h.calls.filter((c) => !c.id.startsWith('svc:instagram.')).map((c) => c.id);
    expect(ids).toEqual([SHEET_READ, SHEET_READ, SHEET_WRITE]); // count+header, then the key column (B), then one write — no create
    expect(h.calls.filter((c) => c.id === SHEET_READ)[1].ctx.args.ranges).toEqual(['Sheet1!C:C']);
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.first_cell_location).toBe('A5');
    expect(write.args.values.map((r: any[]) => r[2])).toEqual(['own-smarthomeindia', 'own-homeautomationindia', 'own-homeautomation']); // 6 merged − 3 already there
    expect(h.steps.some((s) => s.label === 'Appended 3 rows (3 already in the sheet — skipped, matched on "shortcode")')).toBe(true);
    expect(h.agent.updateAgent).not.toHaveBeenCalled(); // already remembered
    // a job that wants a new sheet per run never reads a key column
    const n = harness({ byArgs });
    await n.svc.run('run8', fiveHashtags());
    expect(n.calls.some((c) => c.id === SHEET_READ)).toBe(false);
  });

  it('every row already in the sheet → done and honest: "Nothing new", no write, WhatsApp skipped', async () => {
    const h = harness({ byArgs, existing: { count: 7, header: ['source', 'caption', 'shortcode'], keyValues: ['shared', ...HASHTAGS.map((x) => `own-${x}`)] } });
    await h.svc.run('run9', fiveHashtags({ sheetId: 'SHEET_ONE', notifyWhatsApp: true }));
    expect(h.calls.some((c) => c.id === SHEET_WRITE)).toBe(false);
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/Nothing new — all 6 rows are already in the sheet \(matched on "shortcode"\)/);
    expect(h.finish[0].resultText).toMatch(/WhatsApp skipped/);
    expect(h.alerts.runFinished).not.toHaveBeenCalled();
  });

  it('the sheet helpers: key column by KEY_FIELDS order and case-blind, column letters, dropSeenRows never guesses without a matching column', () => {
    expect(keyColumnIndex(['source', 'Caption', 'URL', 'id'])).toBe(3); // id before url
    expect(keyColumnIndex(['source', 'caption'])).toBe(-1);
    // an owner field never beats an item id/link — two posts by one creator are two rows (review finding)
    expect(keyColumnIndex(['user_id', 'caption', 'url'])).toBe(2);
    expect(keyColumnIndex(['username', 'follower_count'])).toBe(0); // a profiles table keys on the username when that is all there is
    const posts = mergeTables([
      { id: 'a', table: { columns: ['url', 'user_id', 'caption'], rows: [['https://ig.com/p/1', 'u1', 'post one']], itemCount: 1 } },
      { id: 'b', table: { columns: ['url', 'user_id', 'caption'], rows: [['https://ig.com/p/2', 'u1', 'post two']], itemCount: 1 } },
    ]);
    expect(posts.rows).toHaveLength(2);
    expect(posts.dedupe).toEqual({ column: 'url', dropped: 0 });
    expect([colLetter(0), colLetter(1), colLetter(25), colLetter(26), colLetter(27)]).toEqual(['A', 'B', 'Z', 'AA', 'AB']);
    const t = { columns: ['creator', 'link'], rows: [['a', 'l1'], ['b', 'l2'], ['c', '']], itemCount: 3 };
    expect(dropSeenRows(t, { column: 'Link', values: new Set(['l2']) })).toEqual({ table: { ...t, rows: [['a', 'l1'], ['c', '']] }, skipped: 1 });
    expect(dropSeenRows(t, { column: 'shortcode', values: new Set(['l2']) })).toEqual({ table: t, skipped: 0 });
  });
});

describe('the ENGINE road with outputDest sheet — deliverTextToSheet (never a dead switch)', () => {
  it('shapes the answer into rows through social-shape, writes the sheet, hands back the built url', async () => {
    const h = harness();
    const out = await h.svc.deliverTextToSheet('run9', job({ prompt: 'List the top smart-home brands in India with their city' }), 'Brands', 'Legrand — Mumbai. Anchor — Pune.');
    expect(out).toEqual({ url: 'https://docs.google.com/spreadsheets/d/SHEET_NEW', rows: 1, created: true });
    expect((h.llm.completeHelper as jest.Mock).mock.calls[0][0]).toBe('social-shape');
    expect(h.calls.map((c) => c.id)).toEqual([SHEET_CREATE, SHEET_WRITE]);
    expect(h.calls[1].ctx.args.first_cell_location).toBe('A1');
    for (const c of h.calls) expect(c.ctx).toMatchObject({ runId: 'run9', runKind: 'agent', argsPinned: true });
  });
  it('appends under an existing sheet\'s header, and throws (so the run fails) when Sheets is not connected', async () => {
    const h = harness({ existing: { count: 3, header: ['creator', 'link'] } });
    await h.svc.deliverTextToSheet('run9', job({ prompt: 'x', sheetId: 'S' }), 'T', 'some answer');
    expect(h.calls.map((c) => c.id)).toEqual([SHEET_READ, SHEET_WRITE]);
    expect(h.calls[1].ctx.args.first_cell_location).toBe('A4');
    const nc = harness({ sheets: 'not-connected' });
    await expect(nc.svc.deliverTextToSheet('run9', job({ prompt: 'x' }), 'T', 'answer')).rejects.toThrow(/^Connect Google Sheets first/);
  });
  it('a shaping model that answers nothing throws — the caller must fail the run', async () => {
    const h = harness({ shapeReply: null });
    await expect(h.svc.deliverTextToSheet('run9', job({ prompt: 'x' }), 'T', 'answer')).rejects.toThrow(/Could not shape the answer into rows/);
    expect(h.calls.some((c) => c.id === SHEET_CREATE)).toBe(false);
  });
});

/**
 * BEA-1359 — the owner's example is a TWO-source digest, and the vendor's Google-indexed searches
 * answer `404 not_found` for a query with no posts (for stretches, for every query). A not_found on
 * a SEARCH is an empty source — 0 items, 0 credits, said plainly on the run — never a failed run.
 * A transport error, 401/402/429/5xx or any other `success:false` still fails it. All sources empty
 * → the run finishes honestly: "0 posts found — nothing to write, no sheet made", nothing sent.
 */
describe('BEA-1359 — a vendor not_found on a search is an empty source, not a failed run', () => {
  const HASHTAG = 'svc:instagram.search_hashtag';
  const REELS = 'svc:instagram.reels_search';
  const NOT_FOUND = { ok: false, error: 'Instagram could not do that: No posts found', credits: 0, status: 404, notFound: true, serviceName: 'Instagram', actionName: 'Search Hashtag Posts' };
  const two = (over: any = {}) => job({ tools: [HASHTAG, REELS], toolArgs: { [HASHTAG]: { hashtag: 'smarthomeindia', date_posted: 'last-month' }, [REELS]: { query: 'smart home India', date_posted: 'last-month' } }, notifyWhatsApp: true, ...over });

  it('isEmptySearch: only a notFound answer, and only on a search endpoint', () => {
    expect(isEmptySearch(HASHTAG, NOT_FOUND as any)).toBe(true);
    expect(isEmptySearch(REELS, NOT_FOUND as any)).toBe(true);
    expect(isEmptySearch('svc:instagram.profile', NOT_FOUND as any)).toBe(false); // a missing profile is a real failure
    expect(isEmptySearch(HASHTAG, { ok: false, error: 'rate-limited', status: 429 } as any)).toBe(false);
    expect(nounOf(HASHTAG)).toBe('posts');
    expect(nounOf(REELS)).toBe('reels');
    expect(nounOf('svc:instagram.search')).toBe('results');
  });

  it('one search empty, the other with posts → the run completes with the rows it has, and says the empty one plainly', async () => {
    const h = harness({ perTool: { [HASHTAG]: NOT_FOUND, [REELS]: { ok: true, data: POSTS, credits: 1, serviceName: 'Instagram', actionName: 'Search Reels' } } });
    await h.svc.run('run1', two());
    expect(h.finish[0].status).toBe('done');
    expect(h.steps.some((s) => /Instagram · Search Hashtag Posts — no posts found \(vendor answered not_found\) · 0 credits/.test(s.label) && s.status === 'done')).toBe(true);
    // the sheet was made from the reels rows alone
    const write = h.calls.find((c) => c.id === SHEET_WRITE)!.ctx;
    expect(write.args.values).toHaveLength(3); // header + 2 rows
    expect(h.finish[0].outputUrl).toBe('https://docs.google.com/spreadsheets/d/SHEET_NEW');
    // and the WhatsApp went out — there were real rows
    expect(h.alerts.runFinished).toHaveBeenCalled();
  });

  it('every search empty → done honestly: 0 posts found, no sheet made, no WhatsApp, and the run says why', async () => {
    const h = harness({ perTool: { [HASHTAG]: NOT_FOUND, [REELS]: { ...NOT_FOUND, actionName: 'Search Reels' } } });
    await h.svc.run('run1', two());
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/0 posts found — nothing to write, no sheet made/);
    expect(h.finish[0].resultText).toMatch(/every one of the 2 searches/);
    expect(h.finish[0].outputUrl).toBeUndefined();
    expect(h.calls.map((c) => c.id)).toEqual([HASHTAG, REELS]); // no create, no write
    expect(h.alerts.runFinished).not.toHaveBeenCalled(); // nothing to send
    expect(h.llm.completeHelper).not.toHaveBeenCalled(); // no shaping of nothing
    expect(h.steps.filter((s) => /no (posts|reels) found \(vendor answered not_found\)/.test(s.label))).toHaveLength(2);
  });

  it('a Watch job with every search empty also finishes "0 found" and stores no baseline', async () => {
    const h = harness({ perTool: { [HASHTAG]: NOT_FOUND, [REELS]: NOT_FOUND } });
    await h.svc.run('run1', two({ mode: 'watch' }));
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/0 posts found/);
  });

  it('any OTHER refusal still fails the run — 429, a transport error, a not_found on a profile', async () => {
    for (const bad of [
      { ok: false, error: 'Instagram could not do that: Scrape Creators is rate-limiting us right now — try again in a minute.', status: 429, serviceName: 'Instagram' },
      { ok: false, error: 'Instagram could not do that: fetch failed (ECONNRESET: socket hang up)', serviceName: 'Instagram' },
      { ok: false, error: 'Instagram could not do that: The Scrape Creators account is out of credits.', status: 402, outOfCredits: true, serviceName: 'Instagram' },
    ]) {
      const h = harness({ perTool: { [HASHTAG]: bad, [REELS]: { ok: true, data: POSTS, credits: 1, serviceName: 'Instagram', actionName: 'Search Reels' } } });
      await h.svc.run('run1', two());
      expect(h.finish[0].status).toBe('failed');
      expect(h.calls.some((c) => c.id === SHEET_CREATE)).toBe(false);
    }
    const h = harness({ perTool: { 'svc:instagram.profile': { ...NOT_FOUND, actionName: 'Profile' } } });
    await h.svc.run('run1', job({ tools: ['svc:instagram.profile'], toolArgs: { 'svc:instagram.profile': { handle: 'nobody_here_x' } } }));
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/No posts found/);
  });
});

describe('BEA-1359 — what the shaping model is shown, and how long it may take', () => {
  const CDN = 'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/554420070_n.jpg?stp=dst-jpg_e35&_nc_cat=100&ccb=7-5&_nc_sid=18de74&oh=00_AQEse9YM4KsE&oe=6A896C01';
  it('shapeInput drops signed CDN links and blanks, keeps the post link, caps long text', () => {
    const item = { shortcode: 'DO_b2nVjB5O', url: 'https://www.instagram.com/reel/DO_b2nVjB5O/', display_url: CDN, video_url: CDN.replace('.jpg', '.mp4'), owner_profile_pic_url: CDN, caption: 'x'.repeat(2000), like_count: 0, play_count: 44078, empty: '', nothing: null };
    const out = shapeInput(item);
    expect(out.url).toBe('https://www.instagram.com/reel/DO_b2nVjB5O/');
    expect(out.display_url).toBeUndefined();
    expect(out.video_url).toBeUndefined();
    expect(out.owner_profile_pic_url).toBeUndefined();
    expect(out.caption.length).toBe(701); // 700 + the ellipsis
    expect(out.like_count).toBe(0); // a real zero is kept
    expect(out.play_count).toBe(44078);
    expect('empty' in out).toBe(false);
    expect('nothing' in out).toBe(false);
  });

  it('the shaping call is made with a longer timeout than a one-turn helper, and the model never sees a CDN link', async () => {
    const h = harness({ perTool: { 'svc:instagram.search_popular': { ok: true, data: { success: true, credits_charged: 1, posts: [{ shortcode: 'A', url: 'https://www.instagram.com/p/A/', display_url: CDN, caption: 'Smart switches, Kalyan' }] }, credits: 1, serviceName: 'Instagram', actionName: 'Popular Search' } } });
    await h.svc.run('run1', job({ tools: ['svc:instagram.search_popular'], toolArgs: { 'svc:instagram.search_popular': { query: 'smart home india' } }, prompt: 'Columns: creator, link' }));
    expect(h.llm.completeHelper).toHaveBeenCalledTimes(1);
    const [key, prompt, , label, opts] = h.llm.completeHelper.mock.calls[0] as any[];
    expect(key).toBe('social-shape');
    expect(label).toBe('social-shape');
    expect(opts).toEqual({ timeoutMs: 180_000 });
    expect(prompt).not.toContain('cdninstagram');
    expect(prompt).toContain('https://www.instagram.com/p/A/');
    expect(h.finish[0].status).toBe('done');
  });
});
