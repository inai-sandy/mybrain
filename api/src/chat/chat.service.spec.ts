import { ChatService } from './chat.service';

function make(opts: { session?: any; hits?: any[]; answer?: string; item?: any } = {}) {
  const messages: any[] = [];
  let n = 0;
  const session = opts.session ?? { id: 's1', scope: 'bookmark', summary: null, title: null };
  const prisma: any = {
    chatSession: {
      findUnique: async () => session,
      create: async ({ data }: any) => ({ id: 's1', createdAt: new Date(), ...data }),
      findMany: async () => [],
      update: async () => ({}),
      delete: async () => ({}),
    },
    chatMessage: {
      findMany: async () => messages.slice(),
      create: async ({ data }: any) => {
        const row = { id: `m${++n}`, createdAt: new Date(), starred: false, ...data };
        messages.push(row);
        return row;
      },
      deleteMany: async () => ({}),
    },
    item: { findFirst: async () => opts.item ?? null },
  };
  const memory: any = { searchScoped: jest.fn(async () => opts.hits ?? []) };
  const llm: any = { complete: jest.fn(async () => opts.answer ?? 'An answer.\nFOLLOWUPS: a? | b?') };
  return { svc: new ChatService(prisma, memory, llm), memory, llm, messages };
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
    llm.complete.mockResolvedValueOnce('{"search": false, "query": ""}'); // router
    llm.complete.mockResolvedValueOnce('Follow-up answer.\nFOLLOWUPS: x?'); // answer
    void messages;
    await svc.sendMessage('s1', 'explain that simpler');
    expect(memory.searchScoped).toHaveBeenCalledTimes(1); // not called again
  });
});
