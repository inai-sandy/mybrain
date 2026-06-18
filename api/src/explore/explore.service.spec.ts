import { ExploreService } from './explore.service';

function make(hits: any[], answer = 'You shipped it on Tuesday [1].') {
  const memory: any = { searchBrain: jest.fn(async () => hits) };
  const llm: any = { completeWith: jest.fn(async () => answer) };
  // No explore.llm setting → ask() falls back to the default model.
  const prisma: any = { setting: { findUnique: async () => null } };
  return { svc: new ExploreService(prisma, memory, llm), memory, llm };
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

  it('handles an empty question without calling the model', async () => {
    const { svc, memory, llm } = make([]);
    const out = await svc.ask('   ');
    expect(out).toEqual({ answer: '', sources: [], matches: 0 });
    expect(memory.searchBrain).not.toHaveBeenCalled();
    expect(llm.completeWith).not.toHaveBeenCalled();
  });

  it('says so plainly when the brain has nothing (no crash)', async () => {
    const { svc, llm } = make([]);
    const out = await svc.ask('something never recorded');
    expect(out.matches).toBe(0);
    expect(out.sources).toHaveLength(0);
    expect(out.answer).toMatch(/couldn't find/i);
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
    return { s: new ExploreService(prisma, {} as any, {} as any), rows };
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
