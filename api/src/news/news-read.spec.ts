import { NewsReadService } from './news-read.service';

/**
 * BEA-1260 — reading an edition.
 *
 * The page is handed EVERY story in one call. That is deliberate: a story behind a second request
 * is a story that goes missing when that request fails, and complete coverage is the whole promise
 * of this feature.
 */

function svc(over: any = {}) {
  const edition =
    'edition' in over
      ? over.edition
      : {
          id: 'e1',
          issueId: 'i1',
          number: 3,
          day: '2026-07-31',
          headline: 'DeepSeek resets the price war',
          sixty: JSON.stringify(['One', 'Two']),
          sections: JSON.stringify([
            { category: 'Models & releases', line: 'Big day for models', prose: 'A paragraph.', storyCount: 2, written: true },
            { category: 'Policy & law', line: 'Courts moved', prose: '', storyCount: 1, written: false },
          ]),
          storyCount: 3,
          engineOk: false,
          notes: JSON.stringify(['Policy & law could not be produced.']),
          published: true,
          createdAt: new Date(),
        };
  const stories =
    over.stories || [
      { id: 's1', text: 'DeepSeek shipped V4-Flash. It is fast.', theme: 'The launch', category: 'Models & releases', sourceKind: 'twitter', links: '["https://x.com/a"]', flagged: true },
      { id: 's2', text: 'Open weights landed.', theme: 'The launch', category: 'Models & releases', sourceKind: 'twitter', links: '[]', flagged: false },
      { id: 's3', text: 'A court ruled on training data.', theme: null, category: 'Policy & law', sourceKind: 'reddit', links: 'not json', flagged: false },
    ];
  const prisma: any = {
    newsEdition: {
      findUnique: async () => edition,
      // Membership test, not a nullish default: `latest: null` means "there is no latest",
      // and `null ?? edition` would hand back the edition instead.
      findFirst: async () => ('latest' in over ? over.latest : edition),
      findMany: async () => over.list || [edition],
    },
    newsIssue: { findUnique: async () => ('issue' in over ? over.issue : { title: 'not much happened today', link: 'https://news.smol.ai/issues/x/', pubDate: new Date() }) },
    newsStory: { findMany: async () => stories },
  };
  return new NewsReadService(prisma);
}

describe('one whole edition (BEA-1260)', () => {
  it('returns every story, under its category, in the fixed order', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.sections.map((s: any) => s.category)).toEqual(['Models & releases', 'Policy & law']);
    expect(e.sections[0].stories.map((s: any) => s.id)).toEqual(['s1', 's2']);
    expect(e.sections[1].stories.map((s: any) => s.id)).toEqual(['s3']);
  });

  it('says plainly whether the page holds everything the edition claims', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.storyCount).toBe(3);
    expect(e.shown).toBe(3);
    expect(e.complete).toBe(true);
  });

  it('flags an edition whose stories do not add up, instead of quietly showing fewer', async () => {
    // If the page just rendered what it got, a lost story would look like a quiet day.
    const e: any = await svc({ stories: [{ id: 's1', text: 'only one', theme: null, category: 'Research', sourceKind: 'twitter', links: '[]', flagged: false }] }).byDay('2026-07-31');
    expect(e.shown).toBe(1);
    expect(e.complete).toBe(false);
  });

  it('a category the engine could not write STILL carries its stories', async () => {
    // This is what makes an engine failure a plainer edition rather than a shorter one.
    const e: any = await svc().byDay('2026-07-31');
    const policy = e.sections.find((s: any) => s.category === 'Policy & law');
    expect(policy.written).toBe(false);
    expect(policy.prose).toBe('');
    expect(policy.stories).toHaveLength(1);
  });

  it('carries the engine-failed notes so the page can say what is missing', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.engineOk).toBe(false);
    expect(e.notes).toEqual(['Policy & law could not be produced.']);
  });

  it('gives the second axis for free — how many came from where', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.bySource).toEqual({ twitter: 2, reddit: 1 });
  });

  it('corrupt links on a story do not break the edition', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.sections[1].stories[0].links).toEqual([]);
    expect(e.sections[0].stories[0].links).toEqual(['https://x.com/a']);
  });

  it('surfaces the shortlist separately', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.flagged.map((s: any) => s.id)).toEqual(['s1']);
  });

  it('credits the source, with its link', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.source.link).toContain('news.smol.ai');
  });

  it('a day with no edition is a clean 404, not a crash', async () => {
    await expect(svc({ edition: null }).byDay('1999-01-01')).rejects.toThrow(/No edition for that day/);
  });

  it('a story whose category went missing still shows, as Uncategorised', async () => {
    const e: any = await svc({ stories: [{ id: 's1', text: 'orphan', theme: null, category: null, sourceKind: 'twitter', links: '[]', flagged: false }] }).byDay('2026-07-31');
    expect(e.sections.map((s: any) => s.category)).toEqual(['Uncategorised']);
    expect(e.shown).toBe(1);
  });
});

describe('the archive (BEA-1260)', () => {
  it('lists editions with what each one held', async () => {
    const rows: any = await svc().list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 3, day: '2026-07-31', storyCount: 3, engineOk: false });
    expect(rows[0].categories).toEqual([
      { category: 'Models & releases', count: 2 },
      { category: 'Policy & law', count: 1 },
    ]);
  });

  it('clamps a silly limit rather than trying to load everything', async () => {
    await expect(svc().list(100_000)).resolves.toBeTruthy();
    await expect(svc().list(-5)).resolves.toBeTruthy();
  });

  it('tells the page which day to land on', async () => {
    expect(await svc().latestDay()).toBe('2026-07-31');
    expect(await svc({ latest: null }).latestDay()).toBeNull();
  });
});
