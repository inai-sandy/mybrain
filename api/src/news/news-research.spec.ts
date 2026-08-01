import { LlmService } from '../llm/llm.service';
import { NewsResearchService } from './news-research.service';

/**
 * BEA-1258 — "worth digging into", and the same research popup as bookmarks.
 *
 * Two promises: the AI's picks are a shortlist, never a gate (every story keeps its own research
 * button), and pressing research on a news story does exactly what pressing it on a bookmark does —
 * a JOB inside Research Agent, created but NOT started.
 */

function svc(reply: string | null, rows?: any[]) {
  const stories =
    rows ||
    Array.from({ length: 8 }, (_, i) => ({ id: `s${i + 1}`, text: `story ${i + 1}`, category: 'Research', flagged: false, links: '[]', theme: null }));
  const prisma: any = {
    newsStory: {
      findMany: async ({ where }: any) => stories.filter((s) => (where.flagged ? s.flagged : true)),
      findUnique: async ({ where }: any) => stories.find((s) => s.id === where.id) || null,
      updateMany: async ({ where, data }: any) => {
        const ids: string[] = where.id?.in;
        for (const s of stories) if (!ids || ids.includes(s.id)) Object.assign(s, data);
        return { count: 0 };
      },
    },
    agentRun: { findMany: async () => [] },
  };
  const llm: any = { completeHelper: async () => reply };
  const prompts: any = { get: async () => 'PICK THE ONES WORTH DIGGING INTO' };
  const areas: any = { ensureResearchAgent: async () => ({ id: 'area-research' }) };
  const created: any[] = [];
  const agentSvc: any = {
    createAgent: async (a: any) => {
      created.push(a);
      return { id: 'job-1' };
    },
  };
  return { service: new NewsResearchService(prisma, llm, prompts, areas, agentSvc), stories, created };
}

describe('flagging what is worth digging into (BEA-1258)', () => {
  it('flags the stories the model picked, and only those', async () => {
    const { service, stories } = svc(JSON.stringify({ research: [2, 5] }));
    const out = await service.flagIssue('i1');
    expect(out).toMatchObject({ ok: true, considered: 8, flagged: 2 });
    expect(stories.filter((s) => s.flagged).map((s) => s.id)).toEqual(['s2', 's5']);
  });

  it('an empty list is a good answer, not a failure — some days have nothing to chase', async () => {
    const { service, stories } = svc(JSON.stringify({ research: [] }));
    const out = await service.flagIssue('i1');
    expect(out.ok).toBe(true);
    expect(out.flagged).toBe(0);
    expect(stories.some((s) => s.flagged)).toBe(false);
  });

  it('never flags more than six — a list of thirty is not a shortlist', async () => {
    const { service } = svc(JSON.stringify({ research: [1, 2, 3, 4, 5, 6, 7, 8] }));
    expect((await service.flagIssue('i1')).flagged).toBe(6);
  });

  it('ignores a number that is not in the list rather than flagging the wrong story', async () => {
    const { service, stories } = svc(JSON.stringify({ research: [3, 99, 0, -1, 'x', 3] }));
    const out = await service.flagIssue('i1');
    expect(out.flagged).toBe(1);
    expect(stories.filter((s) => s.flagged).map((s) => s.id)).toEqual(['s3']);
  });

  it('clears the previous flags so a re-run cannot leave yesterday\'s behind', async () => {
    const { service, stories } = svc(JSON.stringify({ research: [1] }));
    stories[6].flagged = true;
    await service.flagIssue('i1');
    expect(stories.filter((s) => s.flagged).map((s) => s.id)).toEqual(['s1']);
  });

  it('says plainly when the model fails, and points out you can still flag stories yourself', async () => {
    const { service, stories } = svc(null);
    const out = await service.flagIssue('i1');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('own research button');
    expect(stories.some((s) => s.flagged)).toBe(false); // and nothing is wrongly flagged
  });

  it('a failed re-run KEEPS yesterday\'s good picks instead of wiping them', async () => {
    // The bug this locks: flags were cleared BEFORE the model was asked. A rate limit or a network
    // blip then left the edition showing nothing to chase — indistinguishable from a genuinely
    // quiet day, with the good shortlist gone for good.
    const { service, stories } = svc(null);
    stories[1].flagged = true;
    stories[4].flagged = true;
    const out = await service.flagIssue('i1');
    expect(out.ok).toBe(false);
    expect(stories.filter((s) => s.flagged).map((s) => s.id)).toEqual(['s2', 's5']);
  });

  it('a truncated reply flags nothing rather than guessing', async () => {
    const { service } = svc('{"research":[3,');
    const out = await service.flagIssue('i1');
    expect(out.ok).toBe(false);
    expect(out.flagged).toBe(0);
  });

  it('an issue with no stories says so instead of reporting a clean zero', async () => {
    const { service } = svc(JSON.stringify({ research: [] }), []);
    const out = await service.flagIssue('i1');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('split it first');
  });

  it('runs on a small named model, not the engine and not the general setting', async () => {
    expect(LlmService.HELPERS['news-flag']).toEqual(LlmService.HELPERS['deep-research-plan']);
    expect(LlmService.HELPERS['news-flag']).not.toEqual(LlmService.FOLLOW_ENGINE);
  });
});

describe('researching one news story — the same steps as a bookmark (BEA-1258)', () => {
  it('creates a JOB inside Research Agent, created but NOT started', async () => {
    const { service, created } = svc(null, [
      { id: 's1', text: 'DeepSeek shipped V4-Flash with big agent gains.', category: 'Models & releases', theme: 'The launch', links: '["https://x.com/a"]', flagged: false },
    ]);
    const out = await service.research('s1', 'how fast is it really');
    expect(out).toMatchObject({ ok: true, jobId: 'job-1', areaId: 'area-research', url: '/agent/a/job-1' });
    expect(created).toHaveLength(1);
    expect(created[0].name).toContain('Research:');
  });

  it('gives the agent the story, its links and the owner\'s own words', async () => {
    const { service, created } = svc(null, [
      { id: 's1', text: 'DeepSeek shipped V4-Flash.', category: 'Models & releases', theme: 'The launch', links: '["https://x.com/a","https://hf.co/b"]', flagged: false },
    ]);
    await service.research('s1', 'is the benchmark claim real');
    const p = created[0].prompt;
    expect(p).toContain('[news-story:s1]');
    expect(p).toContain('DeepSeek shipped V4-Flash.');
    expect(p).toContain('https://hf.co/b');
    expect(p).toContain('is the benchmark claim real');
    expect(p).toContain('Save the report as a document');
  });

  it('refuses an empty question, in the same words bookmarks use', async () => {
    const { service } = svc(null);
    expect(await service.research('s1', '   ')).toMatchObject({ ok: false, message: 'Tell me what you want to research first' });
  });

  it('a story that does not exist gets a clear answer, not a crash', async () => {
    const { service } = svc(null, []);
    expect(await service.research('nope', 'dig')).toMatchObject({ ok: false, message: 'Story not found' });
  });

  it('corrupt links do not stop the research', async () => {
    const { service, created } = svc(null, [{ id: 's1', text: 'a story', category: 'Research', theme: null, links: 'not json', flagged: false }]);
    const out = await service.research('s1', 'dig in');
    expect(out.ok).toBe(true);
    expect(created[0].prompt).toContain('a story');
  });
});
