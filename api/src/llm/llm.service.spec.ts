import { LlmService } from './llm.service';

function make(initial: any) {
  const store: any = { row: initial };
  const prisma: any = {
    setting: {
      findUnique: async () => store.row,
      upsert: async ({ create, update }: any) => {
        store.row = store.row ? { ...store.row, value: update.value } : create;
        return store.row;
      },
    },
  };
  const connectors: any = { get: async () => null };
  return { svc: new LlmService(connectors, prisma) };
}

describe('LlmService', () => {
  it('returns null config when unset', async () => {
    expect(await make(null).svc.getConfig()).toBeNull();
  });

  it('round-trips provider + model', async () => {
    const { svc } = make(null);
    await svc.setConfig('anthropic', 'claude-haiku-4-5-20251001');
    const cfg = await svc.getConfig();
    expect(cfg?.provider).toBe('anthropic');
    expect(cfg?.model).toBe('claude-haiku-4-5-20251001');
  });

  it('complete() returns null without a configured model', async () => {
    expect(await make(null).svc.complete('hello')).toBeNull();
  });
});

/**
 * BEA-1179. Prompts grow; ceilings do not. The mentor wrote nothing for two nights and the weekly
 * review missed three weeks — both cut off at their ceiling, both discarded in silence, both paid
 * for. Nineteen features were running into their ceilings when I swept the logs.
 *
 * This is the standing check: any reply that comes back AT its ceiling says so, loudly, every time.
 */
describe('a reply that hits its ceiling is never silent (BEA-1179)', () => {
  function spy() {
    const { svc } = make(null);
    const said: string[] = [];
    (svc as any).log = { warn: (m: string) => said.push(m), error: () => {}, log: () => {} };
    (svc as any).prisma.usageLog = { create: async () => ({}) };
    return { svc, said, log: (usage: any, ceiling?: number) => (svc as any).logUsage('weekly-review', 'm', usage, ceiling) };
  }

  it('warns when the reply came back at the ceiling', async () => {
    const h = spy();
    await h.log({ completion_tokens: 1400 }, 1400);
    expect(h.said).toHaveLength(1);
    expect(h.said[0]).toContain('weekly-review');
    expect(h.said[0]).toContain('CUT OFF');
  });

  it('stays quiet when the reply came back OVER the ceiling — that one was not cut off', async () => {
    // Some providers treat max_tokens as advisory. `emo-router`, capped at 800, returns 1,200-2,000
    // routinely and those replies are complete. Warning on those buried the real cases. (BEA-1179)
    const h = spy();
    await h.log({ completion_tokens: 1500 }, 1400);
    expect(h.said).toHaveLength(0);
  });

  it('stays quiet when the reply finished with room to spare', async () => {
    const h = spy();
    await h.log({ completion_tokens: 900 }, 1400);
    expect(h.said).toHaveLength(0);
  });

  it('reads the other providers\' field name for the same number', async () => {
    const h = spy();
    await h.log({ output_tokens: 1400 }, 1400); // Anthropic calls it output_tokens
    expect(h.said).toHaveLength(1);
  });

  it('says nothing when no ceiling was given, or usage is missing', async () => {
    const h = spy();
    await h.log({ completion_tokens: 9999 });
    await h.log(null, 1400);
    await h.log(undefined, 1400);
    expect(h.said).toHaveLength(0);
  });

  it('a logging problem never breaks the actual request', async () => {
    const h = spy();
    (h.svc as any).prisma.usageLog = { create: async () => { throw new Error('db down'); } };
    await expect(h.log({ completion_tokens: 1400 }, 1400)).resolves.toBeUndefined();
    expect(h.said).toHaveLength(1); // and it still warned
  });
});

/**
 * BEA-1359 — a caller may ask one call to wait longer than the one-turn default (a Social shaping
 * batch on Sonnet took over 60s and was cut off), through `LlmCallOpts.timeoutMs`; the ceiling is
 * still a ceiling. Nothing changes for callers that pass nothing.
 */
describe('LlmCallOpts.timeoutMs (BEA-1359)', () => {
  const origFetch = global.fetch;
  afterEach(() => { global.fetch = origFetch; });
  const build = () => new LlmService({ get: async () => ({ apiKey: 'k' }) } as any, { setting: { findUnique: async () => null }, usageLog: { create: async () => undefined } } as any);

  it('passes the asked timeout to the provider call, capped at 5 minutes; the default is 60s', async () => {
    const seen: number[] = [];
    // The AbortSignal is created from the timeout; watch which value was asked for.
    const origTimeout = AbortSignal.timeout;
    (AbortSignal as any).timeout = (ms: number) => { seen.push(ms); return origTimeout.call(AbortSignal, ms); };
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: {} }) })) as any;
    try {
      const s = build();
      const cfg = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' } as any;
      expect(await s.completeWith(cfg, 'p', 10, 'x')).toBe('ok');
      expect(await s.completeWith(cfg, 'p', 10, 'x', { timeoutMs: 180_000 })).toBe('ok');
      expect(await s.completeWith(cfg, 'p', 10, 'x', { timeoutMs: 999_999_999 })).toBe('ok');
      expect(await s.completeWithModel(cfg, 'p', 10, 'x', { timeoutMs: 120_000 })).toMatchObject({ text: 'ok' });
    } finally {
      (AbortSignal as any).timeout = origTimeout;
    }
    expect(seen).toEqual([60_000, 180_000, 300_000, 120_000]);
  });
});
