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
