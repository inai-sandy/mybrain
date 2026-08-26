import { TryActionService, TRY_BUDGET } from './try-action.service';

/**
 * TRY IT WHILE YOU BUILD (BEA-1484).
 *
 * The owner, after thirteen builds in one day: *"today we make this work. Tomorrow one more will
 * fail. the code has to work every agent that we create."*
 *
 * He was right, and the cause was structural. Codex wrote a whole program blind — able to read
 * documents about his tools but never to call one — so it guessed from good documentation and found
 * out the truth by failing in production, one fact per rebuild, with me in the middle.
 *
 * This is the console it never had. It began as reads-only; BEA-1491 opened it to writes as well,
 * after four builds in a row failed and every one failed on a write. What the tests guard now is the
 * runaway budget and the ledger — never what an action does.
 */

function svc(opts: { byId?: any; result?: any } = {}) {
  const calls: any[] = [];
  const actions: any = {
    runDetailed: async (id: string, _i: string, ctx: any) => {
      calls.push({ id, ctx });
      return opts.result ?? { ok: true, data: { messages: [{ id: 'm1', subject: 'hello' }] } };
    },
  };
  const catalog: any = { byId: async (id: string) => (opts.byId ? opts.byId(id) : null) };
  return { s: new TryActionService(actions, catalog), calls };
}

describe('what a build may try', () => {
  it('makes a real read and hands back the real answer', async () => {
    const w = svc({ byId: () => ({ method: 'GET' }) });
    const r = await w.s.run('b1', 'svc:gmail.fetch_emails', { max_results: 5 });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ messages: [{ id: 'm1', subject: 'hello' }] });
    // Recorded like any other call — what a build did while thinking is never a mystery.
    expect(w.calls[0].ctx.runKind).toBe('build');
    expect(w.calls[0].ctx.args).toEqual({ max_results: 5 });
  });

  /**
   * BEA-1491 — his decision, asked directly with the irreversible-send risk spelled out:
   * **"everything, no exceptions"**. Reads-only was the last remaining cause of repeated failures:
   * four builds of his daily-email agent failed in a row and every one failed on a WRITE whose shape
   * had to be guessed from a description — one of which was itself cut off mid-sentence.
   *
   * These three tests replace the three that used to assert the opposite. Do not reinstate those:
   * an action being a write, being risky, or being unknown is no longer a reason to refuse it.
   */
  it('tries a WRITE for real — this is the point of BEA-1491', async () => {
    const w = svc({ byId: () => ({ method: 'POST', risky: true }), result: { ok: true, data: { id: 'page-1' } } });
    const r = await w.s.run('b1', 'svc:notion.create_notion_page', { title: 'x', parent_id: 'p' });

    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ id: 'page-1' });
    expect(w.calls).toHaveLength(1);                       // it really reached the vendor
    expect(w.calls[0].ctx.runKind).toBe('build');          // and it is in his ledger like any other
  });

  it('tries an action it cannot classify at all, rather than failing closed', async () => {
    const w = svc({ byId: () => null });
    const r = await w.s.run('b1', 'svc:whatever.frobnicate_thing', {});
    expect(r.ok).toBe(true);
    expect(w.calls).toHaveLength(1);
  });

  it('tries a send — the one he was warned about and chose anyway', async () => {
    const w = svc({ byId: () => ({ method: 'POST', risky: true }), result: { ok: true, data: { status: 'sent' } } });
    const r = await w.s.run('b1', 'svc:whatsapp.send_text', { to: '+91...', message: 'test' });
    expect(r.ok).toBe(true);
    expect(w.calls).toHaveLength(1);
  });

  it('stops at the budget, and tells it what to do instead of guessing', async () => {
    const w = svc({ byId: () => ({ method: 'GET' }) });
    for (let i = 0; i < TRY_BUDGET; i++) await w.s.run('b1', 'svc:gmail.fetch_emails', {});
    const over = await w.s.run('b1', 'svc:gmail.fetch_emails', {});

    expect(over.ok).toBe(false);
    expect(over.refused).toContain('handle both shapes rather than guessing one');
    expect(w.calls).toHaveLength(TRY_BUDGET);
  });

  it('gives each build its own budget', async () => {
    const w = svc({ byId: () => ({ method: 'GET' }) });
    for (let i = 0; i < TRY_BUDGET; i++) await w.s.run('b1', 'svc:gmail.fetch_emails', {});
    expect((await w.s.run('b2', 'svc:gmail.fetch_emails', {})).ok).toBe(true);
  });

  it('passes a vendor error straight through — the error IS the discovery', async () => {
    // "Notion can see zero pages" is the single most useful thing a build can learn, and it only
    // ever arrives as a failure.
    const w = svc({ byId: () => ({ method: 'GET' }), result: { ok: false, error: 'HTTP 413: payload too large' } });
    const r = await w.s.run('b1', 'svc:gmail.fetch_emails', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('413');
  });

  it('says which arguments were dropped, so it can fix its own spelling', async () => {
    const w = svc({ byId: () => ({ method: 'GET' }), result: { ok: true, data: {}, droppedArgs: ['maxResults'] } });
    expect((await w.s.run('b1', 'svc:gmail.fetch_emails', { maxResults: 5 })).droppedArgs).toEqual(['maxResults']);
  });

  it('trims a huge answer to readable text instead of handing back nothing', async () => {
    const big = { items: Array.from({ length: 4000 }, (_, i) => ({ id: `i${i}`, text: 'x'.repeat(40) })) };
    const w = svc({ byId: () => ({ method: 'GET' }), result: { ok: true, data: big } });
    const r = await w.s.run('b1', 'svc:gmail.fetch_emails', {});
    expect(r.truncated).toBe(true);
    expect(typeof r.data).toBe('string');
    expect(String(r.data)).toContain('trimmed');
  });

  it('refuses an id that is not an action at all', async () => {
    const w = svc();
    expect((await w.s.run('b1', 'gmail', {})).refused).toContain('starts with "svc:"');
  });
});

/**
 * THE DESCRIPTION IS PART OF THE RULE (BEA-1492).
 *
 * BEA-1491 removed the read-only refusal from the server, and the very next build made ZERO calls.
 * The reason was not the server: the MCP tool description Codex actually reads still said
 * *"Reads only — an action that changes something is refused."* It was told writes were forbidden, so
 * it did not try one. A rule with a second call site, for the fifth time this week.
 *
 * This reads the real MCP server file. If anyone reinstates the old sentence there, this fails.
 */
describe('what Codex is TOLD matches what the server does', () => {
  const mcp = () => require('fs').readFileSync(require('path').join(__dirname, '../../../services/host/mybrain-mcp.server.mjs'), 'utf8');

  it('does not tell Codex that writes are refused', () => {
    const t = mcp();
    expect(t).not.toContain('Reads only');
    expect(t).not.toMatch(/an action that changes something is refused/i);
  });

  it('tells it plainly that writes are allowed, and asks it to tidy up', () => {
    const t = mcp();
    expect(t).toContain('Reads AND writes');
    expect(t).toMatch(/archive or delete any test item you create/i);
  });
});
