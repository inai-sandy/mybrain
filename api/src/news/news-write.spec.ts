import { LlmService } from '../llm/llm.service';
import { NewsWriteService } from './news-write.service';

/**
 * BEA-1257 — Codex writes the edition.
 *
 * Two rules drive every test here:
 *  1. The engine writes WORDS, never the page. It is never asked for HTML, and nothing it returns
 *     is treated as markup.
 *  2. A day the engine is down still produces a REAL edition — every story, every link, every
 *     category, just without the prose — and it says so. A run may never claim success when a step
 *     failed.
 */

function svc(reply: string | null | ((prompt: string) => string | null), rows?: any[]) {
  const stories =
    rows ||
    [
      { id: 's1', text: 'DeepSeek shipped V4-Flash in public beta.', theme: 'The launch', category: 'Models & releases', sourceKind: 'twitter', links: '[]' },
      { id: 's2', text: 'Open weights landed on Hugging Face.', theme: 'The launch', category: 'Models & releases', sourceKind: 'twitter', links: '[]' },
      { id: 's3', text: 'A court ruled on training data.', theme: null, category: 'Policy & law', sourceKind: 'reddit', links: '[]' },
    ];
  const prisma: any = { newsStory: { findMany: async () => stories } };
  const seen: { prompt: string; key: string; maxTokens: number }[] = [];
  const llm: any = {
    completeHelper: async (key: string, prompt: string, maxTokens: number) => {
      seen.push({ key, prompt, maxTokens });
      return typeof reply === 'function' ? reply(prompt) : reply;
    },
  };
  const prompts: any = { get: async (k: string) => `TEMPLATE:${k}` };
  return { service: new NewsWriteService(prisma, llm, prompts), seen, stories };
}

const SECTION = 'LINE: DeepSeek resets the price war\nWRITE-UP:\nDeepSeek launched V4-Flash and open-weighted it hours later.';
const TOPLINE = 'HEADLINE: DeepSeek resets the price war\n- DeepSeek V4-Flash ships\n- Open weights follow\n- A court rules on training data';

describe('writing an edition (BEA-1257)', () => {
  it('writes one section per category that has stories, in the fixed order', async () => {
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION));
    const d = await service.writeEdition('i1');
    expect(d.sections.map((s) => s.category)).toEqual(['Models & releases', 'Policy & law']);
    expect(d.sections[0].storyCount).toBe(2);
    expect(d.sections[1].storyCount).toBe(1);
  });

  it('leaves an empty category out entirely rather than printing a bare heading', async () => {
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION));
    const d = await service.writeEdition('i1');
    expect(d.sections.some((s) => s.category === 'Chips & hardware')).toBe(false);
  });

  it('pulls out the contents line and the prose', async () => {
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION));
    const d = await service.writeEdition('i1');
    expect(d.sections[0].line).toBe('DeepSeek resets the price war');
    expect(d.sections[0].prose).toContain('open-weighted it hours later');
    expect(d.sections[0].prose).not.toContain('WRITE-UP');
  });

  it('writes its own headline and the five lines most people will actually read', async () => {
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION));
    const d = await service.writeEdition('i1');
    expect(d.headline).toBe('DeepSeek resets the price war');
    expect(d.sixty).toEqual(['DeepSeek V4-Flash ships', 'Open weights follow', 'A court rules on training data']);
    expect(d.engineOk).toBe(true);
  });

  it('runs on the ENGINE, through a registered key', async () => {
    const { service, seen } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION));
    await service.writeEdition('i1');
    expect(seen.every((s) => s.key === 'news-write')).toBe(true);
    expect(LlmService.HELPERS['news-write']).toEqual(LlmService.FOLLOW_ENGINE);
  });

  it('reads the 60-second lines only AFTER the headline, so a stray dash cannot displace a real one', async () => {
    // The digest we send embeds each section's prose verbatim. A model that echoes a dash from it
    // above the headline would otherwise have that scooped into a list capped at five, quietly
    // pushing out something that mattered.
    const echoed = 'Here is what I was given:\n- an echoed fragment from the digest\n\nHEADLINE: The real headline\n- the first real line\n- the second real line';
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? echoed : SECTION));
    const d = await service.writeEdition('i1');
    expect(d.headline).toBe('The real headline');
    expect(d.sixty).toEqual(['the first real line', 'the second real line']);
    expect(d.sixty).not.toContain('an echoed fragment from the digest');
  });

  it('never asks the engine for HTML — it writes words, the template makes the page', async () => {
    // If the engine produced markup we would get a different-shaped site every morning, no way to
    // prove the story count survived, and an injection hole on a public page.
    const { service, seen } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION));
    await service.writeEdition('i1');
    for (const call of seen) expect(call.prompt.toLowerCase()).not.toContain('html');
  });

  it('never hands the engine the raw feed — only the split, categorised stories', async () => {
    const { service, seen } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION));
    await service.writeEdition('i1');
    for (const call of seen) {
      expect(call.prompt).not.toContain('<item>');
      expect(call.prompt).not.toContain('content:encoded');
    }
  });
});

describe('a day the engine is down still gets a real edition (BEA-1257)', () => {
  it('publishes every story and SAYS the write-up is missing', async () => {
    const { service } = svc(null);
    const d = await service.writeEdition('i1');
    expect(d.engineOk).toBe(false);
    expect(d.storyCount).toBe(3);
    expect(d.sections.map((s) => s.category)).toEqual(['Models & releases', 'Policy & law']); // all still there
    expect(d.sections.every((s) => s.written === false)).toBe(true);
    expect(d.notes.join(' ')).toContain('Models & releases');
    expect(d.notes.join(' ')).toContain('listed in full below');
  });

  it('one failed section does not cost the others their write-up', async () => {
    let n = 0;
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : ++n === 1 ? null : SECTION));
    const d = await service.writeEdition('i1');
    expect(d.sections[0].written).toBe(false);
    expect(d.sections[1].written).toBe(true);
    expect(d.engineOk).toBe(false); // and the edition does not claim to be complete
    expect(d.notes).toHaveLength(1);
  });

  it('writes its own headline from the facts rather than borrowing "not much happened today"', async () => {
    // Smol AI titles most days that way. Reusing it would be worse than having no headline.
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? null : SECTION));
    const d = await service.writeEdition('i1');
    expect(d.headline).toBe('3 stories in AI today, mostly models & releases');
    expect(d.sixty).toEqual([]);
    expect(d.engineOk).toBe(false);
  });

  it('a section still counts its stories even with no prose, so nothing looks empty', async () => {
    const { service } = svc(null);
    const d = await service.writeEdition('i1');
    expect(d.sections[0].line).toBe('2 stories');
    expect(d.sections[1].line).toBe('1 story');
  });

  it('an unlabelled reply is kept as the write-up rather than thrown away', async () => {
    const { service } = svc((p) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : 'Just some prose with no labels at all.'));
    const d = await service.writeEdition('i1');
    expect(d.sections[0].written).toBe(true);
    expect(d.sections[0].prose).toBe('Just some prose with no labels at all.');
  });
});

describe('storing the edition (BEA-1257)', () => {
  function withStore(reply: any, editions: any[] = []) {
    const base = svc(reply);
    const prisma: any = (base.service as any).prisma;
    prisma.newsIssue = { findUnique: async () => ({ id: 'i1', pubDate: new Date('2026-07-31T05:44:39Z') }) };
    prisma.newsEdition = {
      findUnique: async ({ where }: any) =>
        editions.find((e) => (where.issueId !== undefined ? e.issueId === where.issueId : e.day === where.day)) || null,
      findFirst: async () => [...editions].sort((a, b) => b.number - a.number)[0] || null,
      create: async ({ data }: any) => {
        const row = { id: `e${editions.length + 1}`, ...data };
        editions.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = editions.find((e) => e.id === where.id);
        Object.assign(row, data);
        return row;
      },
    };
    return { ...base, editions };
  }

  const good = (p: string) => (p.includes('TEMPLATE:news.topline') ? TOPLINE : SECTION);

  it('stores the edition with its day and issue number', async () => {
    const { service, editions } = withStore(good);
    const out = await service.publishEdition('i1');
    expect(out.number).toBe(1);
    expect(out.day).toBe('2026-07-31'); // the issue's own day, in the owner's timezone
    expect(out.storyCount).toBe(3);
    expect(JSON.parse(editions[0].sixty)).toHaveLength(3);
    expect(JSON.parse(editions[0].sections)).toHaveLength(2);
  });

  it('numbers editions in sequence, and never reuses a number', async () => {
    // Counting rows would hand out a number twice if one were ever deleted, and the masthead
    // number is what a reader recognises.
    const { service, editions } = withStore(good, [{ id: 'e1', issueId: 'old', number: 7, day: '2026-07-24' }]);
    const out = await service.publishEdition('i1');
    expect(out.number).toBe(8);
    expect(editions).toHaveLength(2);
  });

  it('re-running replaces the day rather than publishing a second edition of it', async () => {
    const { service, editions } = withStore(good);
    const first = await service.publishEdition('i1');
    const again = await service.publishEdition('i1');
    expect(editions).toHaveLength(1);
    expect(again.number).toBe(first.number); // the number a reader already has does not move
    expect(again.day).toBe(first.day);
  });

  it('actually marks the edition published — writing IS publishing', async () => {
    // The field is called `published`, the method is called publishEdition, and it never set it.
    // A perfect run would have produced an edition nobody could open.
    const { service, editions } = withStore(good);
    await service.publishEdition('i1');
    expect(editions[0].published).toBe(true);
  });

  it('says plainly when two issues land on the same day instead of failing forever', async () => {
    // `day` is unique. A second issue on the same IST day would otherwise hit the constraint on
    // every single retry with nothing to explain it.
    const { service } = withStore(good, [{ id: 'e1', issueId: 'other', number: 3, day: '2026-07-31' }]);
    await expect(service.publishEdition('i1')).rejects.toThrow(/already has an edition/);
  });

  it('refuses to write the same edition twice at once', async () => {
    const { service } = withStore(good);
    const results = await Promise.allSettled([service.publishEdition('i1'), service.publishEdition('i1')]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('already being written');
  });

  it('takes the next number when two publishes collide, rather than surfacing a raw database error', async () => {
    const { service, editions } = withStore(good);
    const prisma: any = (service as any).prisma;
    let first = true;
    const realCreate = prisma.newsEdition.create;
    prisma.newsEdition.create = async (args: any) => {
      if (first) {
        first = false;
        const e: any = new Error('Unique constraint failed on the fields: (`number`)');
        e.code = 'P2002';
        throw e;
      }
      return realCreate(args);
    };
    const out = await service.publishEdition('i1');
    expect(out.number).toBe(2); // took the next one instead of 500ing
    expect(editions).toHaveLength(1);
  });

  it('records honestly that the engine failed, instead of publishing a thin edition quietly', async () => {
    const { service, editions } = withStore(null);
    const out = await service.publishEdition('i1');
    expect(out.engineOk).toBe(false);
    expect(editions[0].engineOk).toBe(false);
    expect(JSON.parse(editions[0].notes).length).toBeGreaterThan(0);
    expect(editions[0].storyCount).toBe(3); // every story still counted
  });
});

describe('it refuses to write on top of unfinished work (BEA-1257)', () => {
  it('throws when the issue has no stories', async () => {
    const { service } = svc(SECTION, []);
    await expect(service.writeEdition('i1')).rejects.toThrow(/split and categorise/);
  });

  it('throws when any story is still missing its category', async () => {
    // Writing now would silently leave those stories out of every section — the exact loss the
    // whole pipeline is built to prevent.
    const { service } = svc(SECTION, [
      { id: 's1', text: 'a', theme: null, category: 'Research', sourceKind: 'twitter', links: '[]' },
      { id: 's2', text: 'b', theme: null, category: null, sourceKind: 'twitter', links: '[]' },
    ]);
    await expect(service.writeEdition('i1')).rejects.toThrow(/categorise the issue before writing/);
  });
});
