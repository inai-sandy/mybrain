import { TokenBudgetService, TokenBudgetError, ENGINE_TURN_TOKENS } from './token-budget.service';

/**
 * BEA-1204 — nothing capped tokens anywhere. 1,063,648 of them went in two days, which emptied the
 * ChatGPT subscription until 28 August, and every call quietly moved to a paid model. Nobody was
 * told. These pin the rules the owner set: it BLOCKS, it never downgrades quietly, and it lets the
 * step in flight finish.
 */
function svc(opts: { logged?: number[][]; day?: string; run?: string } = {}) {
  const rows = (opts.logged || []).map(([p, c]) => ({ promptTokens: p, completionTokens: c }));
  const prisma: any = {
    usageLog: { findMany: async () => rows },
    setting: {
      findUnique: async ({ where }: any) =>
        where.key === 'budget.tokens.day' ? (opts.day !== undefined ? { value: opts.day } : null)
          : where.key === 'budget.tokens.run' ? (opts.run !== undefined ? { value: opts.run } : null)
            : null,
      upsert: async () => undefined,
    },
  };
  return new TokenBudgetService(prisma);
}

describe('the token ceiling (BEA-1204)', () => {
  it('defaults to the 500,000 a day the owner chose', async () => {
    expect(await svc().dayLimit()).toBe(500_000);
  });

  it('adds up everything spent since local midnight', async () => {
    const s = svc({ logged: [[100, 50], [1000, 200]] });
    expect(await s.spentToday()).toBe(1350);
  });

  it('lets a call through while there is room', async () => {
    const s = svc({ logged: [[1000, 1000]] });
    expect((await s.check(5000)).ok).toBe(true);
  });

  // The rule: BLOCK, don't warn. A warning that does not stop anything is what we already had.
  it('refuses a call that would begin past the ceiling', async () => {
    const s = svc({ logged: [[490_000, 5000]], day: '500000' });
    const r = await s.check(20_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/budget is used up/);
    await expect(s.require(20_000)).rejects.toBeInstanceOf(TokenBudgetError);
  });

  it('judges by what the call WOULD cost, not by what is already spent', async () => {
    const s = svc({ logged: [[400_000, 0]], day: '500000' });
    expect((await s.check(50_000)).ok).toBe(true);    // 450k — fits
    expect((await s.check(150_000)).ok).toBe(false);  // 550k — would not
  });

  it('can be switched off with a zero ceiling', async () => {
    const s = svc({ logged: [[9_000_000, 0]], day: '0' });
    expect((await s.check(ENGINE_TURN_TOKENS)).ok).toBe(true);
  });

  /**
   * An engine turn reports nothing until it ends. Two starting together would otherwise both read
   * the same "spent" figure and both be allowed — so the ceiling would be passed by a whole turn.
   */
  it('charges an engine turn up front, so two cannot both slip through', async () => {
    const s = svc({ logged: [[300_000, 0]], day: '500000' });
    expect((await s.check(ENGINE_TURN_TOKENS)).ok).toBe(true);
    const release = s.reserve(ENGINE_TURN_TOKENS);          // first turn starts
    expect((await s.check(ENGINE_TURN_TOKENS)).ok).toBe(false); // second is refused: 300k+118k+118k > 500k
    release();                                              // first finishes, real figure now logged
    expect((await s.check(ENGINE_TURN_TOKENS)).ok).toBe(true);
  });

  it('never releases the same reservation twice', async () => {
    const s = svc({ logged: [[0, 0]] });
    const release = s.reserve(1000);
    release(); release(); release();
    expect(await s.spentToday()).toBe(0);
  });

  it('tells the owner once a day, not once a call', () => {
    const s = svc();
    expect(s.shouldAnnounce()).toBe(true);
    expect(s.shouldAnnounce()).toBe(false);
    expect(s.shouldAnnounce()).toBe(false);
  });

  it('reports today plainly enough to show in Settings', async () => {
    const s = svc({ logged: [[100_000, 25_000]], day: '500000' });
    expect(await s.today()).toMatchObject({ spent: 125_000, limit: 500_000, left: 375_000, pct: 25 });
  });

  it('counts the day from local midnight, not the server\'s', async () => {
    let asked: any = null;
    const prisma: any = {
      usageLog: { findMany: async (a: any) => { asked = a; return []; } },
      setting: { findUnique: async () => null },
    };
    await new TokenBudgetService(prisma).spentToday();
    // IST is UTC+5:30, so the owner's day begins at 18:30 UTC the evening before. Using the
    // server's UTC midnight would reset the budget five and a half hours late — the same trap that
    // had a test failing every Friday until BEA-1202.
    const since: Date = asked.where.at.gte;
    expect(since.getUTCHours()).toBe(18);
    expect(since.getUTCMinutes()).toBe(30);
  });

  it('survives a partial prisma stub rather than taking the app down', async () => {
    const s = new TokenBudgetService({} as any);
    expect(await s.spentToday()).toBe(0);
    expect((await s.check(100)).ok).toBe(true);
  });
});

/**
 * Review findings on BEA-1204. The first is the one that mattered: an engine turn left no trace, so
 * the budget could see it only while it ran. The traffic that emptied the subscription was engine
 * turns — a ceiling blind to exactly that is worse than none, because it looks like protection.
 */
describe('an engine turn can never be invisible (BEA-1204)', () => {
  it('charges the measured average when the runner reports nothing', () => {
    expect(TokenBudgetService.tokensOf(undefined)).toEqual({ prompt: ENGINE_TURN_TOKENS, completion: 0 });
    expect(TokenBudgetService.tokensOf({})).toEqual({ prompt: ENGINE_TURN_TOKENS, completion: 0 });
    expect(TokenBudgetService.tokensOf({ input_tokens: 0, output_tokens: 0 })).toEqual({ prompt: ENGINE_TURN_TOKENS, completion: 0 });
  });

  it('uses the real figure whenever there is one, whatever the provider calls it', () => {
    expect(TokenBudgetService.tokensOf({ input_tokens: 900, output_tokens: 100 })).toEqual({ prompt: 900, completion: 100 });
    expect(TokenBudgetService.tokensOf({ prompt_tokens: 5, completion_tokens: 6 })).toEqual({ prompt: 5, completion: 6 });
    expect(TokenBudgetService.tokensOf({ promptTokens: 7, completionTokens: 8 })).toEqual({ prompt: 7, completion: 8 });
  });

  it('tells the owner at the moment of refusal, because most callers swallow the error', async () => {
    const prisma: any = { usageLog: { findMany: async () => [{ promptTokens: 999_999, completionTokens: 0 }] }, setting: { findUnique: async () => null } };
    const s = new TokenBudgetService(prisma);
    const heard: string[] = [];
    s.onStop((m) => { heard.push(m); });
    await expect(s.require(1)).rejects.toBeInstanceOf(TokenBudgetError);
    await expect(s.require(1)).rejects.toBeInstanceOf(TokenBudgetError);
    expect(heard).toHaveLength(1);                       // once a day, not once a call
    expect(heard[0]).toMatch(/budget is used up/);
  });

  it('a broken notifier can never stop the refusal itself', async () => {
    const prisma: any = { usageLog: { findMany: async () => [{ promptTokens: 999_999, completionTokens: 0 }] }, setting: { findUnique: async () => null } };
    const s = new TokenBudgetService(prisma);
    s.onStop(() => { throw new Error('telegram is down'); });
    await expect(s.require(1)).rejects.toBeInstanceOf(TokenBudgetError);
  });
});

/**
 * BEA-1201 — the engine chain. Codex ran dry on 30 July and every call moved silently to a paid
 * model. One fallback was never the answer; an ORDER is, with everything already paid for by flat
 * fee ahead of anything billed per token.
 *
 * These drive the real `completeWith`, not the source text. An earlier version of this block only
 * grepped for substrings, which would have missed the very bug the review found: the FIRST engine's
 * failure going unlogged.
 */
describe('the engine chain (BEA-1201)', () => {
  const { LlmService } = require('./llm.service');

  function svc(runners: Record<string, string | null>) {
    const tried: string[] = [];
    const warned: string[] = [];
    const s: any = new LlmService({ get: async () => ({ apiKey: 'k' }) } as any, { setting: { findUnique: async () => null } } as any);
    // Stand in for the host runners: each engine either answers or does not.
    s.runAgent = async (cfg: any) => { tried.push(cfg.provider); return runners[cfg.provider] ?? null; };
    s.logUsage = async () => undefined;
    (s as any).log = { warn: (m: string) => warned.push(m), log: () => undefined, error: () => undefined };
    return { s, tried, warned };
  }

  it('stops at the first engine that answers', async () => {
    const { s, tried } = svc({ codex: 'from codex' });
    expect(await s.completeWith({ provider: 'codex', model: 'codex' }, 'hi', 100, 'x')).toBe('from codex');
    expect(tried).toEqual(['codex']);
  });

  it('walks on to the next FREE engine before anything paid', async () => {
    const { s, tried } = svc({ codex: null, claude: 'from claude' });
    expect(await s.completeWith({ provider: 'codex', model: 'codex' }, 'hi', 100, 'x')).toBe('from claude');
    expect(tried).toEqual(['codex', 'claude']);
  });

  it('tries every free engine, in order, before reaching for a paid one', async () => {
    const { s, tried } = svc({ codex: null, claude: null, gemini: null });
    s.completeWith = s.completeWith.bind(s);
    const paid: string[] = [];
    const orig = s.completeWith;
    // The paid fallback re-enters completeWith with the openrouter config; record and stop there.
    s.completeWith = async function (cfg: any, p: string, m: number, l: string) {
      if (cfg?.provider === 'openrouter') { paid.push(l); return 'from the paid model'; }
      return orig.call(this, cfg, p, m, l);
    };
    expect(await s.completeWith({ provider: 'codex', model: 'codex' }, 'hi', 100, 'x')).toBe('from the paid model');
    expect(tried).toEqual(['codex', 'claude', 'gemini']);
    expect(paid[0]).toBe('x-fallback'); // labelled, so the usage log shows what it cost
  });

  // The review's HIGH finding. The original guard skipped the FIRST hop, which is the common case:
  // Codex going dry would move silently to Claude and say nothing.
  it('logs the first engine\'s failure, not just later ones', async () => {
    const { s, warned } = svc({ codex: null, claude: 'ok' });
    await s.completeWith({ provider: 'codex', model: 'codex' }, 'hi', 100, 'x');
    expect(warned.some((w) => w.includes('codex could not answer'))).toBe(true);
  });

  it('starts from the engine the caller asked for, not the top of the list', async () => {
    const { s, tried } = svc({ gemini: 'from gemini' });
    await s.completeWith({ provider: 'gemini', model: 'Gemini 3.5 Flash' }, 'hi', 100, 'x');
    expect(tried).toEqual(['gemini']); // never re-tries codex/claude above it
  });

  it('keeps the caller\'s own model on its own hop', async () => {
    const models: string[] = [];
    const { s } = svc({});
    s.runAgent = async (cfg: any) => { models.push(cfg.model); return cfg.provider === 'gemini' ? 'ok' : null; };
    await s.completeWith({ provider: 'gemini', model: 'Gemini 9 Special' }, 'hi', 100, 'x');
    expect(models[0]).toBe('Gemini 9 Special');
  });
});

/**
 * BEA-1201 — a runner's own /status cannot see quota. Codex reported `ready: true` for a month while
 * refusing every call, so Settings showed a green light on a dead engine. What a real refusal tells
 * us has to outrank a health check that cannot know.
 */
describe('an engine that is out of quota is remembered (BEA-1201)', () => {
  const { LlmService } = require('./llm.service');
  const store: Record<string, string> = {};
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (where.key in store ? { key: where.key, value: store[where.key] } : null),
      upsert: async ({ where, create }: any) => { store[where.key] = create.value; return {}; },
    },
  };
  const svc = () => {
    const s: any = new LlmService({ get: async () => ({ apiKey: 'k' }) } as any, prisma);
    (s as any).log = { warn: () => undefined, log: () => undefined, error: () => undefined };
    return s;
  };

  beforeEach(() => { for (const k of Object.keys(store)) delete store[k]; });

  it('reads the reset time out of the refusal, rather than guessing', async () => {
    const s = svc();
    await (s as any).markEngineLimited('codex', "You've hit your usage limit. Upgrade to Plus, or try again at Aug 28th, 2026 2:55 AM.");
    const lim = await s.engineLimit('codex');
    expect(lim.until.getUTCMonth()).toBe(7);   // August
    expect(lim.until.getUTCFullYear()).toBe(2026);
  });

  it('falls back to an hour when no time is given, so a blip is not a month', async () => {
    const s = svc();
    await (s as any).markEngineLimited('gemini', 'rate limit exceeded');
    const lim = await s.engineLimit('gemini');
    const hours = (lim.until.getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(0.9);
    expect(hours).toBeLessThan(1.1);
  });

  it('forgets the limit once it has passed', async () => {
    store['engine.limit.codex'] = JSON.stringify({ until: new Date(Date.now() - 1000).toISOString(), reason: 'old' });
    expect(await svc().engineLimit('codex')).toBeNull();
  });

  it('skips a known-dead engine instead of spending nine seconds proving it', async () => {
    const s = svc();
    let called = 0;
    (global as any).fetch = async () => { called++; return { ok: true, json: async () => ({ text: 'hi' }) }; };
    store['engine.limit.codex'] = JSON.stringify({ until: new Date(Date.now() + 3600_000).toISOString(), reason: 'out' });
    expect(await (s as any).runAgent({ provider: 'codex', model: 'codex' }, 'x')).toBeNull();
    expect(called).toBe(0);
  });
});
