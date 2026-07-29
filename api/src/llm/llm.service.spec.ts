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

  it('warns when it somehow came back OVER the ceiling too', async () => {
    const h = spy();
    await h.log({ completion_tokens: 1500 }, 1400);
    expect(h.said).toHaveLength(1);
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
