import { decodeEntities, parseDate, parseFeed } from './feed-parse';
import { NewsFeedService } from './news-feed.service';

/**
 * BEA-1254 — fetch and store the Smol AI feed.
 *
 * The two things that can quietly ruin AI News Daily are both tested here: double-decoding
 * entities (which invents markup that was never in the source) and a re-poll erasing full issue
 * content with the summary-only version the feed serves once an issue falls out of its newest ten.
 */

/**
 * Mirrors the REAL feed's shape, checked against the live file on 2026-08-01: plain
 * entity-escaped HTML with **no CDATA anywhere**, entity-inside-entity, many categories.
 *
 * An earlier version of this fixture wrapped everything in CDATA, which meant the tests exercised
 * a code path the live feed never takes. The CDATA case is still covered — deliberately, in its
 * own test below — but it is the tolerated shape, not the real one.
 */
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>AI News</title>
<item>
  <title>not much happened today</title>
  <link>https://news.smol.ai/issues/26-07-31-not-much/</link>
  <pubDate>Fri, 31 Jul 2026 05:44:39 GMT</pubDate>
  <description>a quiet day. The week&apos;s price war &amp; what it means.</description>
  <category>deepseek</category>
  <category>openai</category>
  <category>gpt-5.6-luna</category>
  <category>deepseek</category>
  <content:encoded>&lt;h1&gt;AI Twitter Recap&lt;/h1&gt;
&lt;ul&gt;&lt;li&gt;DeepSeek shipped V4-Flash &amp;#x26; open weights&lt;/li&gt;&lt;/ul&gt;</content:encoded>
</item>
<item>
  <title>an older issue</title>
  <link>https://news.smol.ai/issues/26-01-02-old/</link>
  <pubDate>Fri, 02 Jan 2026 05:44:39 GMT</pubDate>
  <description>only a summary survives out here</description>
  <category>anthropic</category>
</item>
<item>
  <title>an item with no link at all</title>
  <pubDate>Fri, 02 Jan 2026 05:44:39 GMT</pubDate>
</item>
</channel></rss>`;

describe('entity decoding happens exactly once (BEA-1254)', () => {
  it('decodes the basics', () => {
    expect(decodeEntities('&lt;p&gt;hi&lt;/p&gt;')).toBe('<p>hi</p>');
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('&quot;quoted&quot; &apos;single&apos;')).toBe('"quoted" \'single\'');
  });

  it('decodes numeric and hex entities', () => {
    expect(decodeEntities('&#38;')).toBe('&');
    expect(decodeEntities('&#x26;')).toBe('&');
    expect(decodeEntities('caf&#233;')).toBe('café');
  });

  it('does NOT double-decode — the whole reason this is a single pass', () => {
    // Decoding &amp; first and &lt; second would turn this into "<", inventing a tag that the
    // source never contained. One pass makes that impossible.
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('leaves unknown entities alone rather than mangling them', () => {
    expect(decodeEntities('50&percnt; &notreal; done')).toBe('50&percnt; &notreal; done');
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;'); // beyond the last code point
  });

  it('a bad date is null, never an Invalid Date nobody notices', () => {
    expect(parseDate('Fri, 31 Jul 2026 05:44:39 GMT')?.toISOString()).toBe('2026-07-31T05:44:39.000Z');
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('parsing the feed (BEA-1254)', () => {
  const items = parseFeed(FEED);

  it('keeps every item that has a link, and drops the one that cannot be identified', () => {
    expect(items).toHaveLength(2); // the third item has no link, so it can never be stored or deduped
    expect(items.map((i) => i.link)).toEqual([
      'https://news.smol.ai/issues/26-07-31-not-much/',
      'https://news.smol.ai/issues/26-01-02-old/',
    ]);
  });

  it('unescapes content:encoded into real HTML', () => {
    expect(items[0].contentHtml).toContain('<h1>AI Twitter Recap</h1>');
    expect(items[0].contentHtml).toContain('<li>');
  });

  it('leaves the HTML level of escaping intact for the splitter to handle', () => {
    // The feed is escaped twice on purpose. `&amp;#x26;` decodes once to `&#x26;` — still an HTML
    // entity, decoded again when text is pulled out of the HTML in BEA-1255. Decoding it to a bare
    // `&` here would be one decode too many.
    expect(items[0].contentHtml).toContain('&#x26;');
    expect(items[0].contentHtml).not.toContain('V4-Flash & open');
  });

  it('an issue with no content:encoded parses fine and is marked as having none', () => {
    expect(items[1].contentHtml).toBeNull();
    expect(items[1].description).toBe('only a summary survives out here');
  });

  it('collects category tags as entities, de-duplicated', () => {
    expect(items[0].entities).toEqual(['deepseek', 'openai', 'gpt-5.6-luna']);
    expect(items[1].entities).toEqual(['anthropic']);
  });

  it('decodes entities in the description, which the live feed really does use', () => {
    expect(items[0].description).toBe("a quiet day. The week's price war & what it means.");
  });

  it('still copes if the publisher ever switches to CDATA', () => {
    // The live feed uses none. This is the tolerated shape, kept covered so a future switch by the
    // publisher does not quietly produce items whose text is wrapped in `<![CDATA[`.
    const cdata = `<rss><channel><item>
      <title><![CDATA[wrapped title]]></title>
      <link><![CDATA[https://news.smol.ai/issues/cdata/]]></link>
      <pubDate>Fri, 31 Jul 2026 05:44:39 GMT</pubDate>
      <description><![CDATA[wrapped summary]]></description>
      <content:encoded><![CDATA[&lt;h1&gt;Wrapped&lt;/h1&gt;]]></content:encoded>
    </item></channel></rss>`;
    const [only] = parseFeed(cdata);
    expect(only.title).toBe('wrapped title');
    expect(only.link).toBe('https://news.smol.ai/issues/cdata/');
    expect(only.description).toBe('wrapped summary');
    expect(only.contentHtml).toBe('<h1>Wrapped</h1>');
  });

  it('a feed that is empty or rubbish yields nothing rather than throwing', () => {
    expect(parseFeed('')).toEqual([]);
    expect(parseFeed('<rss><channel></channel></rss>')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

/** In-memory stand-in for the one table this service touches. */
function fakePrisma(rows: any[] = []) {
  return {
    rows,
    newsIssue: {
      findUnique: async ({ where }: any) => rows.find((r) => r.link === where.link) || null,
      create: async ({ data }: any) => {
        const row = { id: `id-${rows.length + 1}`, ...data };
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        Object.assign(row, data);
        return row;
      },
      findMany: async () => rows.filter((r) => !r.summaryOnly),
    },
  } as any;
}

class TestFeed extends NewsFeedService {
  constructor(prisma: any, private readonly xml: string | Error) {
    super(prisma);
  }
  protected async fetchXml(): Promise<string> {
    if (this.xml instanceof Error) throw this.xml;
    return this.xml;
  }
}

describe('storing what the feed gives us (BEA-1254)', () => {
  it('stores each issue once, however many times we poll', async () => {
    const prisma = fakePrisma();
    const svc = new TestFeed(prisma, FEED);

    const first = await svc.poll();
    expect(first).toMatchObject({ ok: true, fetched: 2, stored: 2, known: 0, filled: 0 });

    const second = await svc.poll();
    expect(second).toMatchObject({ ok: true, stored: 0, known: 2 });
    expect(prisma.rows).toHaveLength(2);
  });

  it('counts the item it could not identify instead of hiding it', async () => {
    const out = await new TestFeed(fakePrisma(), FEED).poll();
    expect(out.unusable).toBe(1); // the third <item> has no link
  });

  it('marks an issue with no full content as summary-only', async () => {
    const prisma = fakePrisma();
    await new TestFeed(prisma, FEED).poll();
    const full = prisma.rows.find((r: any) => r.link.includes('26-07-31'));
    const summary = prisma.rows.find((r: any) => r.link.includes('26-01-02'));
    expect(full.summaryOnly).toBe(false);
    expect(full.rawHtml).toContain('<h1>');
    expect(summary.summaryOnly).toBe(true);
    expect(summary.rawHtml).toBeNull();
  });

  it('fills in the full content when an issue we only had a summary for gains it', async () => {
    const prisma = fakePrisma([
      { id: 'id-1', link: 'https://news.smol.ai/issues/26-07-31-not-much/', summaryOnly: true, rawHtml: null },
    ]);
    const out = await new TestFeed(prisma, FEED).poll();
    expect(out.filled).toBe(1);
    expect(prisma.rows[0].summaryOnly).toBe(false);
    expect(prisma.rows[0].rawHtml).toContain('AI Twitter Recap');
  });

  it('NEVER erases full content we already hold when the feed serves the summary again', async () => {
    // The real failure this guards: an issue drops out of the feed's newest ten and comes back
    // summary-only. A blind upsert would wipe the text every edition is built from.
    const summaryOnlyFeed = FEED.replace(/<content:encoded>[\s\S]*?<\/content:encoded>/, '');
    const prisma = fakePrisma([
      {
        id: 'id-1',
        link: 'https://news.smol.ai/issues/26-07-31-not-much/',
        summaryOnly: false,
        rawHtml: '<h1>AI Twitter Recap</h1>',
      },
    ]);
    const out = await new TestFeed(prisma, summaryOnlyFeed).poll();
    expect(out.known).toBe(1);
    expect(prisma.rows[0].rawHtml).toBe('<h1>AI Twitter Recap</h1>');
    expect(prisma.rows[0].summaryOnly).toBe(false);
  });
});

describe('the poller looks after itself (BEA-1254)', () => {
  it('polls once on boot, not only an hour later', async () => {
    // Deploys restart this container often. Without a poll on boot the table sits empty after
    // every deploy until someone triggers it by hand.
    const prisma = fakePrisma();
    const svc = new TestFeed(prisma, FEED);
    svc.onModuleInit();
    await new Promise((r) => setImmediate(r));
    expect(prisma.rows.length).toBeGreaterThan(0);
    svc.onModuleDestroy();
  });

  it('two polls at once do not both try to create the same issue', async () => {
    // The hourly timer meeting a hand-triggered "pull now" would otherwise have both see an issue
    // as missing and both insert it, colliding on the unique link.
    const prisma = fakePrisma();
    const svc = new TestFeed(prisma, FEED);
    const [a, b] = await Promise.all([svc.poll(), svc.poll()]);
    const stored = (a.stored || 0) + (b.stored || 0);
    expect(stored).toBe(2); // two issues in the fixture, stored exactly once between them
    expect(prisma.rows).toHaveLength(2);
    expect([a.message, b.message]).toContain('a poll is already running');
  });

  it('one unstorable issue does not abandon the rest of the feed', async () => {
    const prisma = fakePrisma();
    let calls = 0;
    const realCreate = prisma.newsIssue.create;
    prisma.newsIssue.create = async (args: any) => {
      calls++;
      if (calls === 1) throw new Error('UNIQUE constraint failed');
      return realCreate(args);
    };
    const out = await new TestFeed(prisma, FEED).poll();
    expect(out.failed).toBe(1);
    expect(out.stored).toBe(1); // the second issue still got through
    expect(out.ok).toBe(false); // and the poll says so rather than looking clean
    expect(out.message).toContain('could not be stored');
  });
});

describe('a broken fetch is never a quiet day (BEA-1254)', () => {
  it('a failed fetch reports the failure and stores nothing', async () => {
    const prisma = fakePrisma();
    const out = await new TestFeed(prisma, new Error('ECONNREFUSED')).poll();
    expect(out.ok).toBe(false);
    expect(out.message).toContain('ECONNREFUSED');
    expect(prisma.rows).toHaveLength(0);
  });

  it('a feed that parses to zero issues is treated as broken, not as no news', async () => {
    // A day with no news and a day we failed to fetch look identical from the outside. Only one of
    // them is acceptable, so the difference has to be stated.
    const prisma = fakePrisma([{ id: 'id-1', link: 'kept', summaryOnly: false, rawHtml: '<h1>x</h1>' }]);
    const out = await new TestFeed(prisma, '<rss><channel></channel></rss>').poll();
    expect(out.ok).toBe(false);
    expect(out.message).toContain('zero issues');
    expect(prisma.rows).toHaveLength(1); // untouched
  });
});
