import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * BEA-1243 — the automatic chain is Codex, then one NAMED paid model. Nothing in between.
 *
 * It used to be codex → claude → gemini → paid: three hops, each able to fail slowly, through
 * subscriptions the owner isn't maintaining. And the fallback must be pinned by name — the app's
 * general model setting is a moving target (qwen one morning, kimi the same afternoon), and qwen is
 * the model that returned nothing twice and killed two branches of a real run (BEA-1236).
 *
 * These are source locks on purpose: the walk behaviour is tested in token-budget.spec.ts; what a
 * future edit would quietly change is the two constants.
 */

const SRC = readFileSync(join(__dirname, 'llm.service.ts'), 'utf8');

describe('the automatic chain is codex → API, locked (BEA-1243)', () => {
  it('ENGINE_CHAIN holds exactly one engine: codex', () => {
    const m = SRC.match(/const ENGINE_CHAIN: LlmConfig\[\] = \[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    const entries = (m![1].match(/provider:/g) || []).length;
    expect(entries).toBe(1);
    expect(m![1]).toContain("'codex'");
    expect(m![1]).not.toContain("'claude'");
    expect(m![1]).not.toContain("'gemini'");
  });

  it('the fallback is one named API model, not a setting', () => {
    const m = SRC.match(/const AGENT_FALLBACK: LlmConfig = \{([^}]*)\};/);
    expect(m).toBeTruthy();
    expect(m![1]).toContain("provider: 'openrouter'");
    // Named, concrete, and an Anthropic model — never resolved from getConfig()/the 'llm' setting.
    expect(m![1]).toMatch(/model: 'anthropic\/[a-z0-9.-]+'/);
  });

  it('the runners the owner can pick BY HAND still include claude and gemini', () => {
    const m = SRC.match(/const KNOWN_ENGINES: LlmConfig\[\] = \[([\s\S]*?)\];/);
    expect(m).toBeTruthy();
    for (const p of ["'codex'", "'claude'", "'gemini'"]) expect(m![1]).toContain(p);
  });
});

describe('hand-picked engines still work — they just stopped being automatic backups (BEA-1243)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LlmService } = require('./llm.service');

  function svc(runners: Record<string, string | null>) {
    const tried: string[] = [];
    const s: any = new LlmService({ get: async () => ({ apiKey: 'k' }) } as any, { setting: { findUnique: async () => null, upsert: async () => ({}), deleteMany: async () => ({ count: 0 }) } } as any);
    s.runAgent = async (cfg: any) => { tried.push(cfg.provider); return runners[cfg.provider] ?? null; };
    s.logUsage = async () => undefined;
    s.log = { warn: () => undefined, log: () => undefined, error: () => undefined };
    return { s, tried };
  }

  it('a hand-picked Claude engine is tried AS claude, not silently swapped for codex', async () => {
    const { s, tried } = svc({ claude: 'from claude' });
    const out = await s.completeWithModel({ provider: 'claude', model: 'claude' }, 'hi', 100, 'x');
    expect(out.text).toBe('from claude');
    expect(out.flatRate).toBe(true);
    expect(tried).toEqual(['claude']);
  });

  it('setEngineChoice still accepts claude and gemini — manual choice survives the chain cut', async () => {
    const { s } = svc({});
    await expect(s.setEngineChoice('claude')).resolves.toMatchObject({ provider: 'claude' });
    await expect(s.setEngineChoice('gemini')).resolves.toMatchObject({ provider: 'gemini' });
    await expect(s.setEngineChoice('nonsense')).rejects.toThrow('Unknown engine');
  });

  it('recheckEngine still knows claude and gemini, so "Upgraded my plan — try again" keeps working', async () => {
    const { s } = svc({ claude: 'OK' });
    const r = await s.recheckEngine('claude');
    expect(r.ok).toBe(true);
    await expect(s.recheckEngine('nonsense')).rejects.toThrow('Unknown engine');
  });
});
