import { LlmService } from '../llm/llm.service';
import { NEWS_CATEGORIES, NewsCategoriseService, UNCATEGORISED } from './news-categorise.service';

/**
 * BEA-1256 — every story gets a category, and the count cannot shrink.
 *
 * The owner's rule: "categorize without missing any news article in it". Splitting guaranteed the
 * count (BEA-1255); this stage has to carry it. A story the model fails to place must land in
 * Uncategorised — a real, visible category — and never disappear.
 */

function svc(reply: string | null | ((prompt: string) => string | null), rows?: any[]) {
  const stories =
    rows ||
    Array.from({ length: 3 }, (_, i) => ({ id: `s${i + 1}`, text: `story ${i + 1}`, theme: null, sectionPath: 'AI Twitter Recap', kind: 'story', category: null }));
  const prisma: any = {
    newsStory: {
      findMany: async () => stories.map((s) => ({ id: s.id, text: s.text, theme: s.theme, sectionPath: s.sectionPath })),
      update: async ({ where, data }: any) => {
        const row = stories.find((s) => s.id === where.id);
        Object.assign(row, data);
        return row;
      },
      count: async () => stories.filter((s) => s.category !== null && s.category !== undefined).length,
      groupBy: async () => {
        const m = new Map<string, number>();
        for (const s of stories) m.set(s.category || UNCATEGORISED, (m.get(s.category || UNCATEGORISED) || 0) + 1);
        return [...m].map(([category, n]) => ({ category, _count: { _all: n } }));
      },
    },
  };
  const seen: { prompt: string; key: string; maxTokens: number }[] = [];
  const llm: any = {
    completeHelper: async (key: string, prompt: string, maxTokens: number) => {
      seen.push({ key, prompt, maxTokens });
      return typeof reply === 'function' ? reply(prompt) : reply;
    },
  };
  const prompts: any = { get: async () => 'FILE THESE STORIES' };
  return { service: new NewsCategoriseService(prisma, llm, prompts), stories, seen };
}

const ok = (...cats: string[]) => JSON.stringify({ items: cats.map((category, i) => ({ n: i + 1, category })) });

describe('the categories are fixed and the model cannot invent one (BEA-1256)', () => {
  it('holds exactly the eight the owner approved, with Uncategorised last', () => {
    expect([...NEWS_CATEGORIES]).toEqual([
      'Models & releases',
      'Research',
      'Tools & building',
      'Money & business',
      'Policy & law',
      'Chips & hardware',
      'Talk & opinion',
      'Uncategorised',
    ]);
  });

  it('accepts a real name whatever its case or spacing', () => {
    expect(NewsCategoriseService.toCategory('Research')).toBe('Research');
    expect(NewsCategoriseService.toCategory('  policy & law  ')).toBe('Policy & law');
  });

  it('refuses anything not on the list, so no invented section can appear', () => {
    expect(NewsCategoriseService.toCategory('Robotics')).toBeNull();
    expect(NewsCategoriseService.toCategory('models')).toBeNull(); // close, but not a real name
    expect(NewsCategoriseService.toCategory(42)).toBeNull();
    expect(NewsCategoriseService.toCategory(null)).toBeNull();
  });
});

describe('categorising an issue (BEA-1256)', () => {
  it('gives every story the category the model chose', async () => {
    const { service, stories } = svc(ok('Research', 'Money & business', 'Policy & law'));
    const out = await service.categoriseIssue('i1');
    expect(out).toMatchObject({ ok: true, total: 3, placed: 3, uncategorised: 0, batches: 1 });
    expect(stories.map((s) => s.category)).toEqual(['Research', 'Money & business', 'Policy & law']);
  });

  it('sends the story text with its theme and section as context', async () => {
    const { service, seen } = svc(ok('Research', 'Research', 'Research'), [
      { id: 's1', text: 'DeepSeek shipped V4-Flash', theme: 'The price war', sectionPath: 'AI Twitter Recap', kind: 'story', category: null },
    ]);
    await service.categoriseIssue('i1');
    expect(seen[0].prompt).toContain('1. [The price war — AI Twitter Recap] DeepSeek shipped V4-Flash');
  });

  it('uses the registered helper key, never a bare model call', async () => {
    // A bare llm.complete() follows the app's general model setting — a moving target, and the
    // recurring trap in this codebase. The key is what makes this changeable from Settings.
    const { service, seen } = svc(ok('Research', 'Research', 'Research'));
    await service.categoriseIssue('i1');
    expect(seen[0].key).toBe('news-categorise');
  });

  it('asks for enough room to answer about every story in the batch', async () => {
    const { service, seen } = svc(ok('Research', 'Research', 'Research'));
    await service.categoriseIssue('i1');
    expect(seen[0].maxTokens).toBeGreaterThanOrEqual(3 * 20);
  });

  it('batches a big issue instead of sending 79 stories in one go', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}`, text: `t${i}`, theme: null, sectionPath: '', kind: 'story', category: null }));
    const { service } = svc(() => ok(...Array(25).fill('Research')), many);
    const out = await service.categoriseIssue('i1');
    expect(out.batches).toBe(3); // 25 + 25 + 10
    expect(out.total).toBe(60);
  });
});

describe('nothing is ever lost, whatever the model does (BEA-1256)', () => {
  it('a story the model skipped lands in Uncategorised, not nowhere', async () => {
    const { service, stories, } = svc(JSON.stringify({ items: [{ n: 1, category: 'Research' }, { n: 3, category: 'Policy & law' }] }));
    const out = await service.categoriseIssue('i1');
    expect(out).toMatchObject({ ok: true, total: 3, placed: 2, uncategorised: 1 });
    expect(stories.map((s) => s.category)).toEqual(['Research', UNCATEGORISED, 'Policy & law']);
    expect(out.message).toContain('Uncategorised');
  });

  it('an invented category is thrown away and the story shows as Uncategorised', async () => {
    // The alternative is a section the owner never chose quietly appearing in his paper.
    const { service, stories } = svc(ok('Robotics', 'Research', 'Vibes'));
    const out = await service.categoriseIssue('i1');
    expect(stories.map((s) => s.category)).toEqual([UNCATEGORISED, 'Research', UNCATEGORISED]);
    expect(out.uncategorised).toBe(2);
  });

  it('a truncated reply loses no stories — the whole batch falls through', async () => {
    const { service, stories } = svc('{"items":[{"n":1,"category":"Rese');
    const out = await service.categoriseIssue('i1');
    expect(out.ok).toBe(true);
    expect(out.uncategorised).toBe(3);
    expect(stories.every((s) => s.category === UNCATEGORISED)).toBe(true);
  });

  it('a model that returns nothing still leaves every story with a category', async () => {
    const { service, stories } = svc(null);
    const out = await service.categoriseIssue('i1');
    expect(out.uncategorised).toBe(3);
    expect(stories.every((s) => s.category === UNCATEGORISED)).toBe(true);
  });

  it('prose instead of JSON is handled, not thrown at the user', async () => {
    const { service, stories } = svc('Sure! Here you go:\n```json\n' + ok('Research', 'Research', 'Research') + '\n```\nHope that helps.');
    await service.categoriseIssue('i1');
    expect(stories.every((s) => s.category === 'Research')).toBe(true);
  });

  it('a number outside the batch is ignored rather than writing onto the wrong story', async () => {
    const { service, stories } = svc(JSON.stringify({ items: [{ n: 99, category: 'Research' }, { n: 2, category: 'Research' }] }));
    await service.categoriseIssue('i1');
    expect(stories.map((s) => s.category)).toEqual([UNCATEGORISED, 'Research', UNCATEGORISED]);
  });

  it('one bad batch does not stop the good ones', async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, text: `t${i}`, theme: null, sectionPath: '', kind: 'story', category: null }));
    let call = 0;
    const { service, stories } = svc(() => (++call === 1 ? 'total rubbish' : ok(...Array(25).fill('Research'))), many);
    const out = await service.categoriseIssue('i1');
    expect(out.total).toBe(50);
    expect(out.uncategorised).toBe(25); // the failed batch
    expect(out.placed).toBe(25); // the good one still landed
    expect(stories.every((s) => s.category)).toBe(true); // and EVERY story has one
  });

  it('THROWS if any story would come out without a category', async () => {
    // The count guarantee, carried forward from BEA-1255. A short edition must never be able to
    // look complete.
    const { service } = svc(ok('Research', 'Research', 'Research'), [
      { id: 's1', text: 'a', theme: null, sectionPath: '', kind: 'story', category: null },
      // this one is invisible to update() but counted by findMany, so the recount comes up short
      { id: 'ghost', text: 'b', theme: null, sectionPath: '', kind: 'story', get category() { return null; }, set category(_v) { /* refuses to be written */ } },
    ]);
    await expect(service.categoriseIssue('i1')).rejects.toThrow(/count mismatch/);
  });

  it('an issue with no stories says so instead of reporting a clean zero', async () => {
    const { service } = svc(ok(), []);
    const out = await service.categoriseIssue('i1');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('split it first');
  });
});

describe('the breakdown for the page (BEA-1256)', () => {
  it('keeps the owner\'s order and leaves out empty categories', async () => {
    const { service, stories } = svc(ok('Policy & law', 'Models & releases', 'Policy & law'));
    await service.categoriseIssue('i1');
    expect(await service.breakdown('i1')).toEqual([
      { category: 'Models & releases', count: 1 },
      { category: 'Policy & law', count: 2 },
    ]);
  });
});

describe('the categoriser is pinned to a small named model (BEA-1256)', () => {
  it('is registered, so it can be pointed somewhere from Settings', () => {
    expect(LlmService.HELPERS['news-categorise']).toBeTruthy();
  });

  it('never follows the engine — a CLI turn would cost ~25,000 tokens to answer a filing question', () => {
    expect(LlmService.HELPERS['news-categorise']).not.toEqual(LlmService.FOLLOW_ENGINE);
    expect(LlmService.HELPERS['news-categorise']).toEqual(LlmService.HELPERS['deep-research-plan']);
  });
});
