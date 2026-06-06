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
