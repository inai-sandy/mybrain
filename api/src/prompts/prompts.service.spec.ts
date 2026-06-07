import { PromptsService } from './prompts.service';

function make() {
  const store: Record<string, string> = {};
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (store[where.key] !== undefined ? { key: where.key, value: store[where.key] } : null),
      findMany: async ({ where }: any) => Object.entries(store).filter(([k]) => k.startsWith(where.key.startsWith)).map(([key, value]) => ({ key, value })),
      upsert: async ({ where, create, update }: any) => {
        store[where.key] = update?.value ?? create.value;
        return { key: where.key, value: store[where.key] };
      },
      deleteMany: async ({ where }: any) => {
        delete store[where.key];
        return { count: 1 };
      },
    },
  };
  return { svc: new PromptsService(prisma), store };
}

describe('PromptsService', () => {
  it('returns the built-in default when no override is set', async () => {
    const { svc } = make();
    const p = await svc.get('tasks.dump');
    expect(p).toContain('daily planner');
  });

  it('returns the override once set, and reports it as customized', async () => {
    const { svc } = make();
    await svc.set('tasks.dump', 'My custom planner instructions.');
    expect(await svc.get('tasks.dump')).toBe('My custom planner instructions.');
    const list = await svc.list();
    expect(list.find((p) => p.key === 'tasks.dump')!.customized).toBe(true);
  });

  it('reset restores the default', async () => {
    const { svc } = make();
    await svc.set('tasks.dump', 'temp');
    await svc.reset('tasks.dump');
    expect(await svc.get('tasks.dump')).toContain('daily planner');
  });

  it('a blank value resets rather than storing emptiness', async () => {
    const { svc } = make();
    await svc.set('daily.summary', '   ');
    expect(await svc.get('daily.summary')).toContain('end-of-day summary');
  });

  it('ignores unknown prompt keys', async () => {
    const { svc } = make();
    expect(await svc.set('nope.nope', 'x')).toBeNull();
  });
});
