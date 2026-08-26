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
 * This is the console it never had. The tests that matter are the ones about what it may NOT do: a
 * build that created Notion pages or sent WhatsApp messages while it was still designing would be
 * far worse than the problem it solves.
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

  it('REFUSES anything that changes something, and says how to proceed', async () => {
    // The whole safety of the feature. A build must never create a page or send a message.
    const w = svc({ byId: () => ({ method: 'POST', risky: true }) });
    const r = await w.s.run('b1', 'svc:notion.create_notion_page', { title: 'x' });

    expect(r.ok).toBe(false);
    expect(r.refused).toContain('changes something');
    expect(r.refused).toContain('it will run when the agent runs');
    expect(w.calls).toHaveLength(0); // never reached the vendor
  });

  it('fails CLOSED — an action it cannot classify is treated as a write', async () => {
    const w = svc({ byId: () => null }); // catalog knows nothing, and the verb is not a read verb
    const r = await w.s.run('b1', 'svc:whatever.frobnicate_thing', {});
    expect(r.refused).toContain('changes something');
    expect(w.calls).toHaveLength(0);
  });

  it('lets a read through on the verb alone when the catalog is silent', async () => {
    const w = svc({ byId: () => null });
    expect((await w.s.run('b1', 'svc:gmail.fetch_emails', {})).ok).toBe(true);
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
