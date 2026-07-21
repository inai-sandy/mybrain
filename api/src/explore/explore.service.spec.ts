import { ExploreService } from './explore.service';

function make(hits: any[], answer = 'You shipped it on Tuesday [1].', resolved: any = {}) {
  const memory: any = { searchBrain: jest.fn(async () => hits), searchRag: jest.fn(async () => hits), resolveRefs: jest.fn(async () => resolved) };
  const llm: any = { completeWith: jest.fn(async () => answer) };
  // No explore.llm setting → ask() falls back to the default model.
  const prisma: any = { setting: { findUnique: async () => null } };
  const connectors: any = { get: jest.fn(async () => null) }; // no Tavily key → web search off
  return { svc: new ExploreService(prisma, memory, llm, connectors, { get: async () => 'SYS' } as any), memory, llm };
}

describe('ExploreService.ask', () => {
  it('returns an answer + typed, linked sources grounded in the retrieved hits', async () => {
    const hits = [
      { title: 'Task: ship pricing', content: 'Task — ship pricing page', tags: ['task', 'work'], score: 0.9, when: '2026-06-17T00:00:00Z', source: 'rag' },
      { title: 'Your story 2026-06-16', content: 'Argued pricing with Diksha', tags: ['activity', 'story'], score: 0.8, source: 'supermemory' },
    ];
    const { svc, memory, llm } = make(hits);
    const out = await svc.ask('when did I ship pricing?');

    expect(memory.searchBrain).toHaveBeenCalled();
    expect(out.answer).toContain('Tuesday');
    expect(out.matches).toBe(2);
    expect(out.sources[0]).toMatchObject({ n: 1, sourceType: 'task', link: '/tasks' });
    expect(out.sources[1]).toMatchObject({ n: 2, sourceType: 'story', link: '/activity' });

    // Injection-safe: the prompt fences the passages and tells the model to treat them as data only.
    const prompt = llm.completeWith.mock.calls[0][1];
    expect(prompt).toContain('<<<SOURCES>>>');
    expect(prompt).toContain('DATA ONLY');
  });

  it('ragOnly (BEA-967): searches only the RAG store, never SuperMemory', async () => {
    const hits = [{ title: 'Task: ship pricing', content: 'Task — ship pricing page', tags: ['task'], score: 0.9, source: 'rag' }];
    const { svc, memory } = make(hits);
    const out = await svc.ask('when did I ship pricing?', { ragOnly: true });
    // The question is understood before searching (BEA-1011): the asking-wrapper/punctuation is
    // stripped, so the SEARCH text is the content, not the raw sentence.
    expect(memory.searchRag).toHaveBeenCalledWith('when did I ship pricing', 14);
    expect(memory.searchBrain).not.toHaveBeenCalled();
    expect(out.matches).toBe(1);
  });

  it('handles an empty question without calling the model', async () => {
    const { svc, memory, llm } = make([]);
    const out = await svc.ask('   ');
    expect(out).toEqual({ answer: '', sources: [], matches: 0, usedWeb: false });
    expect(memory.searchBrain).not.toHaveBeenCalled();
    expect(llm.completeWith).not.toHaveBeenCalled();
  });

  it('says so plainly when the brain has nothing (no crash)', async () => {
    const { svc, llm } = make([]);
    const out = await svc.ask('something never recorded');
    expect(out.matches).toBe(0);
    expect(out.sources).toHaveLength(0);
    // Honest empty answer (BEA-1011) — states the gap rather than a flat "couldn't find".
    expect(out.answer).toMatch(/don't have anything saved/i);
    expect(llm.completeWith).not.toHaveBeenCalled();
  });
});

describe('ExploreService saved answers (BEA-339)', () => {
  function make() {
    const rows: any[] = [];
    const prisma: any = {
      setting: { findUnique: async () => null },
      exploreSave: {
        create: async ({ data }: any) => {
          const r = { id: String(rows.length + 1), createdAt: new Date(), ...data };
          rows.push(r);
          return r;
        },
        findMany: async () => [...rows].reverse(), // newest first
        delete: async ({ where }: any) => {
          const i = rows.findIndex((x) => x.id === where.id);
          if (i >= 0) rows.splice(i, 1);
          return {};
        },
      },
    };
    return { s: new ExploreService(prisma, {} as any, {} as any, { get: async () => null } as any, { get: async () => 'SYS' } as any), rows };
  }

  it('saves and lists newest-first, parsing sources', async () => {
    const { s } = make();
    await s.saveAnswer('q1', 'a1', [{ n: 1 }] as any);
    await s.saveAnswer('pricing question', 'about pricing', []);
    const list = await s.listSaves();
    expect(list).toHaveLength(2);
    expect(list[0].question).toBe('pricing question');
    expect(Array.isArray(list[0].sources)).toBe(true);
  });

  it('keyword-filters over question + answer (case-insensitive)', async () => {
    const { s } = make();
    await s.saveAnswer('q1', 'about Diksha and pricing', []);
    await s.saveAnswer('unrelated', 'nothing here', []);
    const hits = await s.listSaves('diksha');
    expect(hits).toHaveLength(1);
    expect(hits[0].answer).toContain('Diksha');
  });

  it('deletes a saved answer', async () => {
    const { s, rows } = make();
    const saved = await s.saveAnswer('q', 'a', []);
    await s.deleteSave(saved!.id);
    expect(rows).toHaveLength(0);
  });
});

describe('ExploreService.ask — source deep links (BEA-340)', () => {
  it('deep-links a resolved document source to /doc/:id', async () => {
    const hits = [{ memId: 'sm-x', title: 'My research', content: 'long research', tags: ['research'], score: 0.9, source: 'supermemory' }];
    const { svc } = make(hits, 'see [1]', { 'sm-x': { type: 'item', id: 'item-99' } });
    const out = await svc.ask('what did my research say?');
    expect(out.sources[0].link).toBe('/doc/item-99');
    expect(out.sources[0].sourceType).toBe('document');
  });

  it('deep-links a story source to /activity?day and never to the dead /find', async () => {
    const hits = [{ memId: 'rag-y', title: 'Story', content: 'the day', tags: ['activity', 'story'], score: 0.8, source: 'rag' }];
    const { svc } = make(hits, 'see [1]', { 'rag-y': { type: 'story', id: 's1', day: '2026-06-16' } });
    const out = await svc.ask('what happened that day?');
    expect(out.sources[0].link).toBe('/activity?day=2026-06-16');
  });

  it('falls back to a real section (not /find) when a hit cannot be resolved', async () => {
    const hits = [{ memId: 'unknown', title: 'External doc', content: 'x', tags: [], score: 0.5, source: 'supermemory' }];
    const { svc } = make(hits, 'see [1]', {}); // no resolution
    const out = await svc.ask('q');
    expect(out.sources[0].link).toBe('/explore'); // was the dead '/find'
  });
});
