import { ChatService } from './chat.service';

function make(opts: { session?: any; hits?: any[]; answer?: string; item?: any; sessions?: any[] } = {}) {
  const messages: any[] = [];
  const stars: any[] = [];
  const settings: Record<string, string> = {};
  const sessions: any[] = opts.sessions ?? [];
  let n = 0;
  const session = opts.session ?? { id: 's1', scope: 'bookmark', summary: null, title: null };
  const prisma: any = {
    chatSession: {
      findUnique: async ({ where }: any) => sessions.find((s) => s.id === where.id) ?? session,
      create: async ({ data }: any) => ({ id: 's1', createdAt: new Date(), ...data }),
      findMany: async ({ where }: any = {}) => sessions.filter((s) => where?.pinned === undefined || s.pinned === where.pinned),
      update: async () => ({}),
      delete: async ({ where }: any) => {
        const i = sessions.findIndex((s) => s.id === where.id);
        if (i >= 0) sessions.splice(i, 1);
        return {};
      },
    },
    chatMessage: {
      findUnique: async ({ where }: any) => messages.find((m) => m.id === where.id) ?? null,
      findMany: async () => messages.slice(),
      create: async ({ data }: any) => {
        const row = { id: `m${++n}`, createdAt: new Date(), starred: false, ...data };
        messages.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const m = messages.find((x) => x.id === where.id);
        if (m) Object.assign(m, data);
        return m;
      },
      deleteMany: async () => ({}),
    },
    chatStar: {
      upsert: async ({ where, create }: any) => {
        if (!stars.find((s) => s.messageId === where.messageId)) stars.push({ id: `st${++n}`, createdAt: new Date(), ...create });
        return {};
      },
      deleteMany: async ({ where }: any) => {
        const i = stars.findIndex((s) => s.messageId === where.messageId);
        if (i >= 0) stars.splice(i, 1);
        return {};
      },
      findMany: async () => stars.slice(),
    },
    item: { findFirst: async () => opts.item ?? null },
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create.value;
        return {};
      },
    },
  };
  const memory: any = { searchScoped: jest.fn(async () => opts.hits ?? []) };
  const reply = async () => opts.answer ?? 'An answer.\nFOLLOWUPS: a? | b?';
  const llm: any = { complete: jest.fn(reply), completeWith: jest.fn(reply), getConfig: async () => ({ provider: 'openrouter', model: 'x' }), listOpenRouterModels: async () => [] };
  const prompts: any = { get: async (k: string) => `[${k} instruction]` };
  return { svc: new ChatService(prisma, memory, llm, prompts), memory, llm, messages, stars, sessions };
}

describe('ChatService', () => {
  it('creates a session with the chosen scope (defaults to everything)', async () => {
    const { svc } = make();
    const s = await svc.createSession('idea');
    expect(s.scope).toBe('idea');
    const d = await svc.createSession('nonsense');
    expect(d.scope).toBe('everything');
  });

  it('scopes the memory search to the thread tag on the first message', async () => {
    const { svc, memory } = make({ hits: [] });
    await svc.sendMessage('s1', 'what did I save about SEO?');
    expect(memory.searchScoped).toHaveBeenCalledWith('what did I save about SEO?', ['bookmark'], 5);
  });

  it('parses the answer and the suggested follow-ups', async () => {
    const { svc } = make({ answer: 'Here is the gist.\nFOLLOWUPS: Tell me more? | Why?' });
    const r = await svc.sendMessage('s1', 'summarise my SEO bookmarks');
    expect(r!.message.content).toBe('Here is the gist.');
    expect(r!.message.followups).toEqual(['Tell me more?', 'Why?']);
  });

  it('maps a memory hit to a clickable internal source when the item is known', async () => {
    const { svc } = make({
      hits: [{ memId: 'sm-1', title: 'Cloud SEO video', content: 'about seo', source: 'supermemory' }],
      item: { id: 'item-9', title: 'Cloud SEO video', sourceUrl: 'https://x' },
    });
    const r = await svc.sendMessage('s1', 'the seo one');
    expect(r!.message.sources[0]).toEqual({ title: 'Cloud SEO video', url: 'https://x', itemId: 'item-9' });
  });

  it('answers from the thread (no search) for a follow-up, but searches a fresh first message', async () => {
    // first message: empty history -> always search
    const { svc, memory, messages, llm } = make({ hits: [] });
    await svc.sendMessage('s1', 'first question');
    expect(memory.searchScoped).toHaveBeenCalledTimes(1);
    // now a follow-up with the router saying no-search
    llm.completeWith.mockResolvedValueOnce('{"search": false, "query": ""}'); // router
    llm.completeWith.mockResolvedValueOnce('Follow-up answer.\nFOLLOWUPS: x?'); // answer
    void messages;
    await svc.sendMessage('s1', 'explain that simpler');
    expect(memory.searchScoped).toHaveBeenCalledTimes(1); // not called again
  });

  it('starring a message preserves a copy that survives retention', async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000); // ~6.5 months ago
    const { svc, stars, sessions } = make({ sessions: [{ id: 'old1', scope: 'idea', title: 'Old chat', pinned: false, lastMessageAt: old, createdAt: old }] });
    // send a message into that session so there's a message to star
    (svc as any); // session findUnique returns the old session
    const r = await svc.sendMessage('old1', 'hello');
    await svc.setStar(r!.message.id, true);
    expect(stars).toHaveLength(1);
    const starred = await svc.listStarred();
    expect(starred).toHaveLength(1);

    // retention (default 2 months) should delete the old thread...
    await svc.retentionTick();
    expect(sessions.find((s) => s.id === 'old1')).toBeUndefined();
    // ...but the starred copy is untouched
    expect((await svc.listStarred())).toHaveLength(1);
  });

  it('keeps pinned threads through retention', async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    const { svc, sessions } = make({ sessions: [{ id: 'p1', scope: 'idea', title: 'Pinned', pinned: true, lastMessageAt: old, createdAt: old }] });
    await svc.retentionTick();
    expect(sessions.find((s) => s.id === 'p1')).toBeDefined();
  });
});
