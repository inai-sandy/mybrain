import { KEEP_AS_FETCHED, SHEET_CREATE, SHEET_READ, SHEET_WRITE, SocialAgentRunService, mergeTables } from './social-agent-run.service';

/**
 * BEA-1357 — a Social agent's run: direct fetch (no engine turn), rows → a Google Sheet through the
 * seam (create, or append), the not-connected refusal, and the WhatsApp "no number" message.
 */

const POSTS = { success: true, credits_charged: 1, posts: [{ url: 'u1', caption: 'Smart home India', like_count: 3, owner: { username: 'a' } }, { url: 'u2', caption: 'Elsewhere', like_count: 5, owner: { username: 'b' } }] };

function harness(opts: { fetchOk?: boolean; sheets?: 'ok' | 'not-connected'; existing?: { count: number; header: string[] } | null; whatsapp?: { sent: boolean; why?: string; via?: 'template' | 'text'; error?: string; note?: string } | null; shapeReply?: string | null; docs?: boolean } = {}) {
  const steps: any[] = [];
  const finish: any[] = [];
  const calls: { id: string; ctx: any }[] = [];
  const agent = {
    appendStep: jest.fn(async (_id: string, s: any) => { steps.push(s); }),
    finishRun: jest.fn(async (_id: string, p: any) => { finish.push(p); }),
    attachOutput: jest.fn(async () => undefined),
  };
  const actions = {
    runDetailed: jest.fn(async (id: string, _input: string, ctx: any) => {
      calls.push({ id, ctx });
      if (id.startsWith('svc:instagram.')) {
        return opts.fetchOk === false
          ? { ok: false, error: 'Instagram could not do that: No posts found', credits: 0, serviceName: 'Instagram', actionName: 'Search' }
          : { ok: true, data: POSTS, credits: 1, serviceName: 'Instagram', actionName: 'Search' };
      }
      if (opts.sheets === 'not-connected') return { ok: false, error: 'Connect Google Sheets first — open /tools, connect it, then run this step again.', serviceName: 'Google Sheets' };
      if (id === SHEET_CREATE) return { ok: true, data: { spreadsheetId: 'SHEET_NEW' } };
      if (id === SHEET_READ) {
        const ex = opts.existing;
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
    const h = harness({ existing: { count: 4, header: ['url', 'caption'] } });
    await h.svc.run('run1', job({ sheetId: 'SHEET_OLD' }));
    const ids = h.calls.map((c) => c.id);
    expect(ids).toEqual(['svc:instagram.search', SHEET_READ, SHEET_WRITE]); // no create
    const read = h.calls.find((c) => c.id === SHEET_READ)!.ctx;
    expect(read.args).toEqual({ spreadsheet_id: 'SHEET_OLD', ranges: ['Sheet1!A:A', 'Sheet1!1:1'] });
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
