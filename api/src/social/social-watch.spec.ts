import { KEEP_AS_FETCHED, SocialAgentRunService, diffTable, thresholdOf } from './social-agent-run.service';
import { SocialBudgetService } from './social-budget.service';
import { SocialWatchStore } from './social-watch.store';
import { stableHash, storable } from './diff';

/**
 * BEA-1358 — Watch and Alert on a Social agent's run, and the daily credit ceiling:
 *  - first run = baseline, nothing "new"; unchanged twice = "nothing changed", no document, no message;
 *  - 3 new posts = exactly those 3 by id, and the new result stored as last;
 *  - a threshold crossed pushes ONCE, not again while it stays above;
 *  - a run that would pass the ceiling pauses the job (`enabled:false`, `pausedReason`), tells the
 *    owner, and makes NO call;
 *  - a failed fetch fails the run and never overwrites the last good result.
 */

const post = (id: string, over: any = {}) => ({ id, caption: `post ${id}`, like_count: 10, url: `https://instagram.com/p/${id}`, ...over });
const listAnswer = (ids: string[]) => ({ success: true, credits_charged: 1, posts: ids.map((i) => post(i)) });
const profile = (followers: number) => ({ success: true, credits_charged: 1, data: { user: { username: 'legrand_in', follower_count: followers, following_count: 12, profile_pic_url: `https://cdn.x/p.jpg?oh=${followers}` } } });

/** An in-memory SocialWatch table behind the real store, so the store's own code is exercised. */
function memPrisma() {
  const rows = new Map<string, any>();
  const k = (w: any) => `${w.agentId}|${w.actionId}|${w.argsHash}`;
  const agents: any[] = [];
  return {
    rows,
    agents,
    socialWatch: {
      findUnique: async ({ where }: any) => rows.get(k(where.agentId_actionId_argsHash)) || null,
      upsert: async ({ where, create, update }: any) => { const key = k(where.agentId_actionId_argsHash); const cur = rows.get(key); rows.set(key, cur ? { ...cur, ...update } : { id: `w${rows.size + 1}`, ...create }); return rows.get(key); },
      findMany: async ({ where }: any) => [...rows.values()].filter((r) => r.agentId === where.agentId),
      deleteMany: async ({ where }: any) => { let n = 0; for (const [key, r] of rows) if (r.agentId === where.agentId) { rows.delete(key); n++; } return { count: n }; },
    },
    agent: { update: async ({ where, data }: any) => { agents.push({ id: where.id, ...data }); return { id: where.id, ...data }; } },
    toolCall: { findFirst: async () => ({ credits: 1 }) },
    setting: { findUnique: async () => null },
  };
}

function harness(opts: { answers?: any[]; fetchOk?: boolean; alertReply?: string | null; telegram?: boolean | 'unlinked'; whatsapp?: { sent: boolean; why?: string }; budget?: { spent: number; ceiling: number | null } } = {}) {
  const steps: any[] = [];
  const finish: any[] = [];
  const calls: { id: string; ctx: any }[] = [];
  const answers = [...(opts.answers || [])];
  const agent = {
    appendStep: jest.fn(async (_id: string, s: any) => { steps.push(s); }),
    finishRun: jest.fn(async (_id: string, p: any) => { finish.push(p); }),
    attachOutput: jest.fn(async () => undefined),
  };
  const actions = {
    runDetailed: jest.fn(async (id: string, _input: string, ctx: any) => {
      calls.push({ id, ctx });
      if (opts.fetchOk === false) return { ok: false, error: 'Instagram could not do that: No posts found', credits: 0, serviceName: 'Instagram', actionName: 'Profile' };
      const data = answers.length ? answers.shift() : listAnswer(['a']);
      return { ok: true, data, credits: 1, serviceName: 'Instagram', actionName: 'Profile' };
    }),
  };
  const llm = { completeHelper: jest.fn(async () => (opts.alertReply === undefined ? '{"fires": true, "why": "a new post mentions a price"}' : opts.alertReply)) };
  const documents = { create: jest.fn(async () => ({ id: 'doc1' })) };
  const alerts = { runFinished: jest.fn(async () => opts.whatsapp || { sent: false, why: 'no number' }), runFailed: jest.fn(async () => ({ sent: false })) };
  const prisma = memPrisma();
  const telegramSends: any[] = [];
  const telegram = opts.telegram === false ? undefined : {
    ownerChatId: async () => (opts.telegram === 'unlinked' ? null : '123'),
    notifySocialAlert: jest.fn(async (a: any) => { if (opts.telegram === 'unlinked') return { sent: false, why: 'no Telegram chat is linked in Settings' }; telegramSends.push({ kind: 'alert', ...a }); return { sent: true }; }),
    notifyJobPaused: jest.fn(async (a: any) => { telegramSends.push({ kind: 'paused', ...a }); }),
  };
  const socialSvc = { spentToday: async () => opts.budget?.spent ?? 0, ceiling: async () => (opts.budget ? opts.budget.ceiling : 500) };
  const provider = { owns: async (id: string) => id.startsWith('svc:instagram.'), listServices: async () => [{ slug: 'instagram' }] };
  const budget = new SocialBudgetService(socialSvc as any, provider as any, prisma as any, telegram as any);
  const watches = new SocialWatchStore(prisma as any);
  const svc = new SocialAgentRunService(agent as any, actions as any, llm as any, documents as any, alerts as any, undefined, budget, watches);
  return { svc, steps, finish, calls, agent, actions, llm, documents, alerts, prisma, telegram, telegramSends, watches, budget };
}

const job = (over: any = {}) => ({ id: 'ag1', name: 'Legrand watch', prompt: KEEP_AS_FETCHED, tools: ['svc:instagram.profile'], toolArgs: { 'svc:instagram.profile': { handle: 'legrand_in' } }, outputDest: 'document', sheetId: null, notifyWhatsApp: false, mode: 'watch', alertCondition: null, threshold: null, enabled: true, ...over });

describe('Watch — first run is a baseline, unchanged is "nothing changed"', () => {
  it('the first run stores a baseline and reports NOTHING as new — no document, no message', async () => {
    const h = harness({ answers: [listAnswer(['a', 'b', 'c'])] });
    await h.svc.run('run1', job());
    expect(h.finish[0].status).toBe('done');
    expect(h.finish[0].resultText).toMatch(/Watching from now/);
    expect(h.finish[0].resultText).not.toMatch(/new item/);
    expect(h.documents.create).not.toHaveBeenCalled();
    expect(h.alerts.runFinished).not.toHaveBeenCalled();
    expect(h.telegramSends).toEqual([]);
    // the row exists, keyed on (agent, action, args), and holds the cleaned answer
    const row = await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' });
    expect(row).not.toBeNull();
    expect(row!.lastHash).toBe(stableHash(listAnswer(['a', 'b', 'c'])));
    expect(row!.lastResult.posts.map((p: any) => p.id)).toEqual(['a', 'b', 'c']);
    expect(h.steps.some((s) => /baseline stored/i.test(s.label))).toBe(true);
  });

  it('the same result twice → "nothing changed", saves no document, sends nothing, and the row is refreshed', async () => {
    const h = harness({ answers: [profile(100), profile(100)] });
    await h.svc.run('run1', job());
    const before = await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' });
    await h.svc.run('run2', job({ notifyWhatsApp: true }));
    expect(h.finish[1].status).toBe('done');
    expect(h.finish[1].resultText).toMatch(/Nothing changed since/);
    expect(h.finish[1].outputDocId).toBeUndefined();
    expect(h.documents.create).not.toHaveBeenCalled();
    expect(h.alerts.runFinished).not.toHaveBeenCalled(); // even with the WhatsApp toggle on
    expect(h.telegramSends).toEqual([]);
    const after = await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' });
    expect(after!.lastHash).toBe(before!.lastHash);
    expect(after!.lastAt.getTime()).toBeGreaterThanOrEqual(before!.lastAt.getTime());
  });
});

describe('Watch — only what changed', () => {
  it('3 new posts between runs → exactly those 3, by id (not position), saved as the output, and the new result stored as last', async () => {
    const h = harness({ answers: [listAnswer(['a', 'b', 'c']), listAnswer(['n1', 'a', 'n2', 'b', 'n3'])] });
    await h.svc.run('run1', job());
    await h.svc.run('run2', job());
    const r = h.finish[1];
    expect(r.status).toBe('done');
    expect(r.resultText).toMatch(/3 new items since/);
    for (const id of ['n1', 'n2', 'n3']) expect(r.resultText).toContain(`\`${id}\``);
    expect(r.resultText).not.toContain('`a`');
    // the document holds only what changed
    expect(h.documents.create).toHaveBeenCalledTimes(1);
    const doc = (h.documents.create as jest.Mock).mock.calls[0][0];
    expect(doc.contentText).toMatch(/3 new items/);
    expect(doc.contentText).not.toContain('`b`');
    expect(r.outputDocId).toBe('doc1');
    // stored as last: the next run's baseline is the 5-item list
    const row = await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' });
    expect(row!.lastResult.posts.map((p: any) => p.id).sort()).toEqual(['a', 'b', 'n1', 'n2', 'n3']);
  });

  it('a follower count that moved → "followers 100 → 150", to a Google Sheet as before/now rows when the job says sheet', async () => {
    const h = harness({ answers: [profile(100), profile(150), { spreadsheetId: 'S1' }, { ok: true }] });
    // the sheet calls answer through the same runDetailed stub — route them by id
    (h.actions.runDetailed as jest.Mock).mockImplementation(async (id: string, _i: string, ctx: any) => {
      h.calls.push({ id, ctx });
      if (id.startsWith('svc:instagram.')) return { ok: true, data: id && h.calls.filter((c) => c.id === id).length === 1 ? profile(100) : profile(150), credits: 1, serviceName: 'Instagram', actionName: 'Profile' };
      if (id.endsWith('create_google_sheet1')) return { ok: true, data: { spreadsheetId: 'S1' } };
      return { ok: true, data: {} };
    });
    await h.svc.run('run1', job({ outputDest: 'sheet' }));
    await h.svc.run('run2', job({ outputDest: 'sheet' }));
    expect(h.finish[1].status).toBe('done');
    expect(h.finish[1].resultText).toMatch(/followers 100 → 150/);
    expect(h.finish[1].outputUrl).toBe('https://docs.google.com/spreadsheets/d/S1');
    const write = h.calls.find((c) => c.id.endsWith('batch_update'))!;
    expect(write.ctx.args.values[0]).toEqual(['checked_at', 'what', 'before', 'now', 'change']);
    expect(write.ctx.args.values[1].slice(1)).toEqual(['followers', 100, 150, 50]);
    // no sheet was touched on the baseline run
    expect(h.calls.filter((c) => c.id.endsWith('create_google_sheet1')).length).toBe(1);
  });
});

describe('Alert — a threshold pushes once; a plain-English condition is ONE helper call', () => {
  const alertJob = (over: any = {}) => job({ mode: 'alert', threshold: { dir: 'above', value: 120 }, ...over });

  it('crossing the line pushes once (Telegram + WhatsApp through AlertsService) — and NOT again while it stays above', async () => {
    const h = harness({ answers: [profile(100), profile(150), profile(160), profile(110), profile(130)], whatsapp: { sent: true } });
    await h.svc.run('r1', alertJob()); // baseline (already below)
    await h.svc.run('r2', alertJob()); // 100 → 150: crossed
    await h.svc.run('r3', alertJob()); // 150 → 160: still above — no push
    await h.svc.run('r4', alertJob()); // 160 → 110: fell below — no push (direction is "above")
    await h.svc.run('r5', alertJob()); // 110 → 130: crossed again — push again
    expect(h.finish.map((f) => f.status)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(h.finish[1].resultText).toMatch(/Alert fired/);
    expect(h.finish[1].resultText).toMatch(/followers went above 120/);
    expect(h.finish[2].resultText).toMatch(/Alert not fired/);
    expect(h.finish[2].resultText).toMatch(/followers 150 → 160/); // the diff is still recorded
    expect(h.finish[3].resultText).toMatch(/Alert not fired/);
    expect(h.finish[4].resultText).toMatch(/Alert fired/);
    expect(h.telegramSends.filter((t) => t.kind === 'alert').length).toBe(2);
    expect(h.alerts.runFinished).toHaveBeenCalledTimes(2);
    // no model call for a numeric threshold
    expect(h.llm.completeHelper).not.toHaveBeenCalled();
    // once-only state is on the row
    const row = await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' });
    expect(row!.alertState).toBe('met');
    expect(row!.lastAlertedAt).not.toBeNull();
    // a fired alert is written to the output too; an unfired one is not
    expect(h.documents.create).toHaveBeenCalledTimes(2);
  });

  it('a plain-English condition is judged by ONE social-alert helper call over the diff — true → push, false → no push but the diff is recorded', async () => {
    const h = harness({ answers: [listAnswer(['a']), listAnswer(['a', 'b']), listAnswer(['a', 'b', 'c'])] });
    (h.llm.completeHelper as jest.Mock).mockResolvedValueOnce('{"fires": false, "why": "the new post has no price in it"}').mockResolvedValueOnce('{"fires": true, "why": "post c says ₹1,299"}');
    const j = job({ mode: 'alert', alertCondition: 'a new post mentions a price' });
    await h.svc.run('r1', j); // baseline — no judging on a baseline
    await h.svc.run('r2', j); // 1 new → false
    await h.svc.run('r3', j); // 1 new → true
    expect(h.llm.completeHelper).toHaveBeenCalledTimes(2);
    expect((h.llm.completeHelper as jest.Mock).mock.calls[0][0]).toBe('social-alert');
    expect((h.llm.completeHelper as jest.Mock).mock.calls[0][1]).toContain('a new post mentions a price');
    expect(h.finish[1].status).toBe('done');
    expect(h.finish[1].resultText).toMatch(/Alert not fired/);
    expect(h.finish[1].resultText).toContain('`b`'); // the diff is recorded
    expect(h.finish[2].resultText).toMatch(/Alert fired/);
    expect(h.finish[2].resultText).toMatch(/post c says/);
    expect(h.telegramSends.length).toBe(1); // only the run that fired pushed
    expect(h.telegramSends[0].text).toMatch(/1 new item/);
  });

  it('the alert model answering nothing FAILS the run and keeps the last good result — it never guesses', async () => {
    const h = harness({ answers: [listAnswer(['a']), listAnswer(['a', 'b'])], alertReply: null });
    const j = job({ mode: 'alert', alertCondition: 'a new post mentions a price' });
    await h.svc.run('r1', j);
    await h.svc.run('r2', j);
    expect(h.finish[1].status).toBe('failed');
    expect(h.finish[1].error).toMatch(/Could not judge the alert condition/);
    const row = await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' });
    expect(row!.lastResult.posts.map((p: any) => p.id)).toEqual(['a']); // NOT overwritten
  });

  it('an alert that fired but reached nobody fails the run (nothing stored, so it fires again next time)', async () => {
    const h = harness({ answers: [profile(100), profile(150)], telegram: 'unlinked', whatsapp: { sent: false, why: 'no number' } });
    await h.svc.run('r1', job({ mode: 'alert', threshold: { dir: 'above', value: 120 } }));
    await h.svc.run('r2', job({ mode: 'alert', threshold: { dir: 'above', value: 120 } }));
    expect(h.finish[1].status).toBe('failed');
    expect(h.finish[1].error).toMatch(/could not reach you/);
    const row = await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' });
    expect(row!.lastResult.data.user.follower_count).toBe(100);
    // and no Document was written for it — a retry must not pile up duplicates
    expect(h.documents.create).not.toHaveBeenCalled();
  });
});

describe('the daily credit ceiling', () => {
  it('a run that would pass the ceiling pauses the job (enabled:false + pausedReason), tells the owner, and makes NO call', async () => {
    const h = harness({ budget: { spent: 500, ceiling: 500 } });
    await h.svc.run('run1', job());
    expect(h.actions.runDetailed).not.toHaveBeenCalled(); // the call was never made
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/daily Social credit ceiling is 500/);
    expect(h.prisma.agents[0]).toMatchObject({ id: 'ag1', enabled: false });
    expect(h.prisma.agents[0].pausedReason).toMatch(/paused itself and no call was made/);
    expect(h.telegramSends[0]).toMatchObject({ kind: 'paused', what: 'Legrand watch' });
    expect(h.telegramSends[0].reason).toMatch(/would pass it/);
    // and no watch row was written
    expect(h.prisma.rows.size).toBe(0);
  });

  it('under the ceiling the call goes ahead; ceiling 0 = no limit; a non-social action (Sheets) never counts', async () => {
    const h = harness({ budget: { spent: 499, ceiling: 500 } });
    await h.svc.run('run1', job());
    expect(h.actions.runDetailed).toHaveBeenCalledTimes(1);
    expect(h.finish[0].status).toBe('done');
    const free = harness({ budget: { spent: 99999, ceiling: null } });
    await free.svc.run('run1', job());
    expect(free.finish[0].status).toBe('done');
    expect(await free.budget.check('svc:googlesheets.batch_update')).toMatchObject({ ok: true });
  });

  it('a guard that cannot answer fails CLOSED — the call is not made, the run fails, the job is not paused', async () => {
    const h = harness();
    (h.budget as any).check = async () => { throw new Error('db locked'); };
    await h.svc.run('run1', job());
    expect(h.actions.runDetailed).not.toHaveBeenCalled();
    expect(h.finish[0].status).toBe('failed');
    expect(h.finish[0].error).toMatch(/Could not check the daily Social credit ceiling/);
    expect(h.prisma.agents.length).toBe(0);
  });

  it('a plain mode:"run" job is guarded by the same ceiling', async () => {
    const h = harness({ budget: { spent: 500, ceiling: 500 } });
    await h.svc.run('run1', job({ mode: 'run' }));
    expect(h.actions.runDetailed).not.toHaveBeenCalled();
    expect(h.prisma.agents[0]).toMatchObject({ enabled: false });
  });
});

describe('failure keeps the last good result', () => {
  it('a failed fetch fails the run with the reason and does NOT touch the watch row', async () => {
    const h = harness({ answers: [listAnswer(['a', 'b'])] });
    await h.svc.run('run1', job());
    const before = JSON.stringify(await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' }));
    (h.actions.runDetailed as jest.Mock).mockResolvedValueOnce({ ok: false, error: 'Instagram could not do that: No posts found', credits: 0, serviceName: 'Instagram', actionName: 'Profile' });
    await h.svc.run('run2', job());
    expect(h.finish[1].status).toBe('failed');
    expect(h.finish[1].error).toMatch(/No posts found/);
    expect(JSON.stringify(await h.watches.get('ag1', 'svc:instagram.profile', { handle: 'legrand_in' }))).toBe(before);
    // and the next good run diffs against the same baseline
    (h.actions.runDetailed as jest.Mock).mockResolvedValueOnce({ ok: true, data: listAnswer(['a', 'b', 'c']), credits: 1, serviceName: 'Instagram', actionName: 'Profile' });
    await h.svc.run('run3', job());
    expect(h.finish[2].resultText).toMatch(/1 new item/);
  });
});

describe('small pieces', () => {
  it('thresholdOf reads JSON text or an object, and rejects nonsense', () => {
    expect(thresholdOf('{"dir":"below","value":"10","field":"following_count"}')).toEqual({ field: 'following_count', dir: 'below', value: 10 });
    expect(thresholdOf({ value: 5 })).toEqual({ field: undefined, dir: 'above', value: 5 });
    expect(thresholdOf({ value: 'x' })).toBeNull();
    expect(thresholdOf(null)).toBeNull();
  });
  it('diffTable: new items as rows, numbers as before/now rows', () => {
    const t = diffTable([{ shape: 'list', changed: true, summary: '', detail: '', newItems: [post('z')] } as any]);
    expect(t.columns).toContain('caption');
    expect(t.rows.length).toBe(1);
    const n = diffTable([{ shape: 'number', changed: true, summary: '', detail: '', numbers: [{ field: 'follower_count', prev: 1, cur: 2, delta: 1 }] } as any]);
    expect(n.rows[0].slice(1)).toEqual(['followers', 1, 2, 1]);
    // two tools, one with new items and one with a moved number → BOTH reach the sheet, with a source column
    const both = diffTable([
      { shape: 'list', changed: true, summary: '', detail: '', newItems: [post('z')] } as any,
      { shape: 'number', changed: true, summary: '', detail: '', numbers: [{ field: 'follower_count', prev: 1, cur: 2, delta: 1 }] } as any,
    ], ['svc:instagram.posts', 'svc:instagram.profile']);
    expect(both.columns[0]).toBe('source');
    expect(both.rows.length).toBe(2);
    expect(both.rows.map((r) => r[0])).toEqual(['instagram.posts', 'instagram.profile']);
    expect(both.columns).toEqual(expect.arrayContaining(['caption', 'what', 'before', 'now']));
  });
  it('the stored result is the cleaned answer, so a stored row and a fresh fetch hash the same', () => {
    expect(stableHash(JSON.parse(storable(profile(1))))).toBe(stableHash(profile(1)));
  });
});
