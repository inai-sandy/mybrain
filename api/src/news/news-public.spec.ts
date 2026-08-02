import { readFileSync } from 'fs';
import { join } from 'path';
import { NewsPublicService } from './news-public.service';

/**
 * BEA-1261 — the page strangers see.
 *
 * The rule that matters: this is a SEPARATE, narrower payload, not the private one with fields
 * switched off. Nothing personal can leak through something somebody forgets to strip, because the
 * private fields are never assembled into it.
 */

const PRIVATE_EDITION = {
  number: 4,
  day: '2026-07-31',
  headline: 'DeepSeek resets the price war',
  sixty: ['One thing happened.', 'Then another.'],
  engineOk: true,
  complete: true,
  notes: [],
  storyCount: 2,
  shown: 2,
  sections: [
    {
      category: 'Models & releases',
      line: 'A busy day',
      prose: 'Some prose.',
      written: true,
      storyCount: 2,
      stories: [
        { id: 'story-secret-id', text: 'DeepSeek shipped V4-Flash. It is fast and cheap.', theme: 'The launch', category: 'Models & releases', sourceKind: 'twitter', links: ['https://x.com/a'], flagged: true },
        { id: 'another-secret-id', text: 'Open weights landed on Hugging Face.', theme: null, category: 'Models & releases', sourceKind: 'reddit', links: [], flagged: false },
      ],
    },
  ],
  flagged: [{ id: 'story-secret-id', text: 'DeepSeek shipped V4-Flash.', category: 'Models & releases' }],
  bySource: { twitter: 1, reddit: 1 },
  source: { title: 'not much happened today', link: 'https://news.smol.ai/issues/x/', pubDate: '2026-07-31' },
};

function svc(over: any = {}) {
  const read: any = {
    byDay: async () => ('edition' in over ? over.edition : PRIVATE_EDITION),
    list: async () => over.list || [{ number: 4, day: '2026-07-31', headline: 'H', storyCount: 2, engineOk: true, sixty: [], categories: [], createdAt: new Date() }],
  };
  const prisma: any = {
    newsEdition: {
      findFirst: async () =>
        'row' in over
          ? over.row
          : { day: '2026-07-31', number: 4, headline: 'DeepSeek resets the price war', sixty: JSON.stringify(['One thing happened.', 'Then another.']), storyCount: 2, published: true },
    },
  };
  return new NewsPublicService(prisma, read);
}

describe('the public payload is narrower by construction (BEA-1261)', () => {
  it('never carries story ids — they are the handle for the owner\'s research endpoints', async () => {
    const e: any = await svc().byDay('2026-07-31');
    const asText = JSON.stringify(e);
    expect(asText).not.toContain('story-secret-id');
    expect(asText).not.toContain('another-secret-id');
    for (const s of e.sections[0].stories) expect(s.id).toBeUndefined();
  });

  it('never carries the owner\'s shortlist or the flags behind it', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.flagged).toBeUndefined();
    expect(JSON.stringify(e)).not.toContain('flagged');
  });

  it('carries nothing about runs, engines or notes', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.engineOk).toBeUndefined();
    expect(e.notes).toBeUndefined();
    expect(e.shown).toBeUndefined();
  });

  it('still gives a reader the actual news — headline, the sixty, sections and sources', async () => {
    const e: any = await svc().byDay('2026-07-31');
    expect(e.headline).toBe('DeepSeek resets the price war');
    expect(e.sixty).toHaveLength(2);
    expect(e.number).toBe(4);
    expect(e.storyCount).toBe(2);
    // The first sentence here is under the 30-character floor, so it keeps the next one too rather
    // than producing a headline of four words. That floor exists so an abbreviation cannot cut a
    // headline off at "V4."
    expect(e.sections[0].stories[0]).toEqual({ headline: 'DeepSeek shipped V4-Flash. It is fast and cheap.', source: 'twitter', links: ['https://x.com/a'] });
  });

  it('tells a reader when part of the edition was not written, same as the owner sees', async () => {
    const e: any = await svc({ edition: { ...PRIVATE_EDITION, engineOk: false } }).byDay('2026-07-31');
    expect(e.complete).toBe(false);
  });

  it('carries NO reference to the upstream source — owner\'s decision, 2026-08-02', async () => {
    // Not hidden by the page: never assembled. The public payload is built field by field, so a
    // later edit cannot render back something that was only ever removed from the template.
    const e: any = await svc().byDay('2026-07-31');
    expect(e.builtOn).toBeUndefined();
    expect(e.source).toBeUndefined();
    expect(JSON.stringify(e).toLowerCase()).not.toContain('smol');
    expect(JSON.stringify(e)).not.toContain('news.smol.ai');
  });

  it('the index gives titles and days only', async () => {
    const rows: any = await svc().index();
    expect(Object.keys(rows[0]).sort()).toEqual(['day', 'headline', 'number', 'storyCount']);
  });
});

describe('the share card a crawler reads (BEA-1261)', () => {
  it('carries the day\'s real headline and the top of the 60-second read', async () => {
    const m: any = await svc().ogMeta('2026-07-31', 'https://mybrain.1site.ai');
    expect(m.title).toBe('DeepSeek resets the price war — AI News Daily');
    expect(m.description).toContain('One thing happened.');
    expect(m.url).toBe('https://mybrain.1site.ai/paper/2026-07-31');
  });

  it('falls back to a real sentence when there is no 60-second read', async () => {
    const m: any = await svc({ row: { day: '2026-07-31', number: 4, headline: 'H', sixty: 'not json', storyCount: 12, published: true } }).ogMeta('2026-07-31', 'https://x.test');
    expect(m.description).toContain('12 stories');
  });

  it('a day with no edition gets no card rather than a broken one', async () => {
    expect(await svc({ row: null }).ogMeta('1999-01-01', 'https://x.test')).toBeNull();
  });
});

describe('the public routes are rate-limited (BEA-1261)', () => {
  // These are the first ANONYMOUS endpoints in the app and the link is meant to be shared widely.
  // The throttler is registered but deliberately not global here — every public surface opts in,
  // and forgetting to is invisible until someone points a scraper at it.
  const CONTROLLER = readFileSync(join(__dirname, 'news.controller.ts'), 'utf8');
  const publicBlock = CONTROLLER.slice(CONTROLLER.indexOf('public/editions') - 800, CONTROLLER.indexOf("@Get('editions')"));

  it('both public routes carry the throttler guard', () => {
    expect((publicBlock.match(/@UseGuards\(ThrottlerGuard\)/g) || []).length).toBe(2);
  });

  it('and an actual limit, not just the guard', () => {
    expect((publicBlock.match(/@Throttle\(\{[^)]*limit:\s*\d+/g) || []).length).toBe(2);
  });

  it('every OTHER news route stays behind auth — @Public is only on the two public ones', () => {
    expect((CONTROLLER.match(/@Public\(\)/g) || []).length).toBe(2);
  });
});

describe('a story headline is readable (BEA-1261)', () => {
  it('cuts at the first sentence', () => {
    expect(NewsPublicService.headlineOf('DeepSeek shipped V4-Flash today. Then more happened.')).toBe('DeepSeek shipped V4-Flash today.');
  });

  it('keeps a short line whole rather than chopping mid-thought', () => {
    expect(NewsPublicService.headlineOf('Big day.')).toBe('Big day.');
  });

  it('trims something enormous', () => {
    const out = NewsPublicService.headlineOf('x'.repeat(500));
    expect(out.length).toBeLessThanOrEqual(201);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('the public page shows no private controls (BEA-1261)', () => {
  // A source-level check, because "I looked and there was no button" is not a guarantee that
  // survives the next edit.
  const PAGE = readFileSync(join(__dirname, '../../../web/src/pages/PaperPublic.tsx'), 'utf8');

  it('never renders the research popup', () => {
    expect(PAGE).not.toContain('ResearchModal');
    expect(PAGE.toLowerCase()).not.toContain('research this');
  });

  it('never calls a private endpoint', () => {
    const calls = PAGE.match(/\/api\/[a-z0-9/:${}._-]+/gi) || [];
    for (const c of calls) expect(c).toMatch(/^\/api\/news\/public\//);
  });

  it('does not pull in the app shell or the sidebar', () => {
    expect(PAGE).not.toContain('AppShell');
    expect(PAGE).not.toContain('ui/nav');
  });

  it('prints each category ONCE — no section reprinted as a lead', () => {
    // BEA-1268. A separate lead block that reprinted the first section's write-up above the
    // section itself put "Models & releases" on the page three times, and the owner read the whole
    // page as repetition. One block per category, the same shape as his own view.
    expect(PAGE).not.toContain('edition.sections[0] &&');
    expect(PAGE).not.toContain('THE LEAD.');
    // exactly one place that renders a section's prose
    expect((PAGE.match(/sec\.prose\.split/g) || []).length).toBe(1);
    expect((PAGE.match(/edition\.sections\.map/g) || []).length).toBe(1);
  });

  it('renders stories at three sizes, not forty identical boxes', () => {
    expect(PAGE).toMatch(/big \?/);
    expect(PAGE).toContain('brief');
    expect(PAGE).toContain('big={i === 0}');
  });

  it('lets a reader reach other editions from the TOP, not only the bottom', () => {
    // The bug the owner caught: the archive existed and linked correctly, 11 phone-screens down
    // past 40 stories. Asserting a thing renders is not the same as asserting a person can get to
    // it. This pins POSITION — the navigation must appear before the first section of stories.
    const navAt = PAGE.indexOf('#all-editions');
    const firstStorySection = PAGE.indexOf('edition.sections.map');
    const archiveAt = PAGE.indexOf('id="all-editions"');
    expect(navAt).toBeGreaterThan(-1);
    expect(navAt).toBeLessThan(firstStorySection);
    // and the jump target is further down, so the link actually goes somewhere
    expect(archiveAt).toBeGreaterThan(firstStorySection);
  });

  it('offers previous and next editions, not just a list', () => {
    expect(PAGE).toContain('Newer');
    expect(PAGE).toContain('Older');
    expect(PAGE).toMatch(/archive\[at - 1\]/);
    expect(PAGE).toMatch(/archive\[at \+ 1\]/);
  });

  it('names and links the upstream source NOWHERE on the page', () => {
    // Owner's decision, 2026-08-02: "dont mention Smol AI News and dont link it to this page."
    expect(PAGE.toLowerCase()).not.toContain('smol');
    expect(PAGE).not.toContain('builtOn');
    expect(PAGE).not.toContain('news.smol.ai');
  });

  it('the footer says what it is built from, with the TRUE subreddit count', () => {
    // The owner asked for "20+ subreddits". The feed's own masthead says 12, and 544 Twitter
    // accounts. "500+" is therefore true and "20+" is not — a number printed on a page he hands to
    // people has to survive somebody checking it.
    // Read the rendered TEXT, not the whole block — the comment above it quotes "20+ subreddits"
    // to explain why the number was corrected, and a naive scan of the source matched that.
    const footer = PAGE.slice(PAGE.indexOf('<footer'));
    const rendered = (footer.match(/>Built from[^<]*/) || [''])[0];
    expect(rendered).toContain('500+ Twitter accounts');
    expect(rendered).toContain('12 subreddits');
    expect(rendered).not.toMatch(/2\d\+ subreddits/i);
  });
});
