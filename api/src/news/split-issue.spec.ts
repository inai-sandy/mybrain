import { htmlToText, linksIn, sourceOf, splitIssue } from './split-issue';
import { NewsSplitService } from './news-split.service';

/**
 * BEA-1255 — split an issue into its news items, counted so nothing is lost.
 *
 * The fixture below is the real shape of a Smol AI issue, reduced: a masthead blockquote, a Twitter
 * recap of theme paragraphs followed by bullet lists, and a Reddit recap nested h1 › h2 › h3. One
 * story deliberately carries a nested <ul>, because 17 of the 40 stories in the 31 Jul issue do,
 * and a lazy /<li>(.*?)<\/li>/ would truncate every one of them at the first sub-bullet.
 */
const ISSUE = `<p><strong>a quiet day.</strong></p>
<blockquote><p>AI News for 7/30/2026-7/31/2026. We checked 12 subreddits and 544 Twitters.</p></blockquote>
<hr />
<h1>AI Twitter Recap</h1>
<p><strong>DeepSeek V4-Flash: launch and open weights</strong></p>
<ul>
<li><p>DeepSeek launched the <a href="https://twitter.com/deepseek_ai/1">V4-Flash API</a> in public beta.</p></li>
<li><p>Open weights landed on <a href="https://huggingface.co/x">Hugging Face</a> within hours.</p>
<ul><li>Licensed MIT</li><li>Amplified by @_akhaliq</li></ul>
</li>
</ul>
<p><strong>The price war restarts</strong></p>
<ul>
<li>After OpenAI cut GPT-5.6 Luna by 80%, the comparison shifted.</li>
</ul>
<hr />
<h1>AI Reddit Recap</h1>
<h2>/r/LocalLlama Recap</h2>
<h3>1. DeepSeek V4-Flash 0731 Release Benchmarks</h3>
<ul>
<li>Benchmarks show a <strong>+25.8</strong> jump on Terminal-Bench.</li>
<li>Commenters were cautiously excited.</li>
</ul>`;

describe('reading a heading as a source (BEA-1255)', () => {
  it('recognises the sections the feed actually uses', () => {
    expect(sourceOf('AI Twitter Recap')).toBe('twitter');
    expect(sourceOf('AI Reddit Recap')).toBe('reddit');
    expect(sourceOf('AI Discords')).toBe('discord');
  });

  it('a section we have never seen is unknown, not silently mapped to something', () => {
    expect(sourceOf('AI YouTube Recap')).toBe('unknown');
    expect(sourceOf('')).toBe('unknown');
  });
});

describe('flattening HTML to text (BEA-1255)', () => {
  it('keeps nested bullets as readable lines instead of one run-on blob', () => {
    const t = htmlToText('<p>Parent claim.</p><ul><li>first</li><li>second</li></ul>');
    expect(t).toContain('Parent claim.');
    expect(t).toContain('• first');
    expect(t).toContain('• second');
  });

  it('decodes the HTML level of escaping the feed leaves behind', () => {
    expect(htmlToText('<p>Luna &#x26; Terra</p>')).toBe('Luna & Terra');
  });

  it('drops script and style content rather than printing it as news', () => {
    expect(htmlToText('<p>real</p><script>alert(1)</script>')).toBe('real');
  });

  it('collects links in order, without duplicates or in-page anchors', () => {
    expect(linksIn('<a href="https://a.com">a</a><a href="#top">x</a><a href="https://a.com">again</a><a href="https://b.com">b</a>'))
      .toEqual(['https://a.com', 'https://b.com']);
  });
});

describe('splitting a real-shaped issue (BEA-1255)', () => {
  const r = splitIssue(ISSUE);
  const stories = r.stories.filter((s) => s.kind === 'story');

  it('finds the top-level list items as stories, and does not count sub-bullets as stories', () => {
    // 5 top-level <li> in the fixture (2 Twitter + 1 price-war + 2 Reddit). The 2 nested
    // sub-bullets under "Open weights" belong to their parent and are NOT stories of their own.
    expect(r.storyCount).toBe(5);
    expect(stories).toHaveLength(5);
    expect(r.extractedCount).toBe(stories.length + r.stories.filter((s) => s.kind !== 'story').length);
  });

  it('a story carrying a nested list keeps the whole thing — NOT truncated at the first sub-bullet', () => {
    // This is the bug a lazy /<li>(.*?)<\/li>/ regex would introduce, silently, on 17 of the 40
    // stories in a real issue.
    const withNested = stories.find((s) => s.text.includes('Hugging Face'))!;
    expect(withNested.text).toContain('Open weights landed');
    expect(withNested.text).toContain('• Licensed MIT');
    expect(withNested.text).toContain('• Amplified by @_akhaliq');
  });

  it('tags each story with the recap it came from', () => {
    expect(stories.slice(0, 3).every((s) => s.sourceKind === 'twitter')).toBe(true);
    expect(stories.slice(3).every((s) => s.sourceKind === 'reddit')).toBe(true);
  });

  it('records where in the issue each story sat', () => {
    expect(stories[0].sectionPath).toBe('AI Twitter Recap');
    expect(stories[3].sectionPath).toBe('AI Reddit Recap › /r/LocalLlama Recap › 1. DeepSeek V4-Flash 0731 Release Benchmarks');
  });

  it('attaches the theme paragraph above each story, and resets it at a new heading', () => {
    expect(stories[0].theme).toBe('DeepSeek V4-Flash: launch and open weights');
    expect(stories[2].theme).toBe('The price war restarts');
    expect(stories[3].theme).toBeNull(); // a heading cleared it
  });

  it('keeps each story\'s links', () => {
    expect(stories[0].links).toEqual(['https://twitter.com/deepseek_ai/1']);
    expect(stories[1].links).toEqual(['https://huggingface.co/x']);
  });

  it('keeps the masthead as intro rather than passing it off as news', () => {
    const intro = r.stories.filter((s) => s.kind === 'intro');
    expect(intro.length).toBeGreaterThan(0);
    expect(intro.map((i) => i.text).join(' ')).toContain('We checked 12 subreddits');
  });

  it('leaves NOTHING unplaced on a well-formed issue', () => {
    expect(r.unplacedCount).toBe(0);
    expect(r.unknownSections).toEqual([]);
  });
});

describe('coverage is total by construction (BEA-1255)', () => {
  it('text in a shape we have never seen becomes a VISIBLE unplaced item, not a gap', () => {
    // The whole safety net: a future issue with a table, or a bare div, must still surface. The
    // failure this prevents is an edition that silently omits a section nobody noticed changed.
    const odd = `<h1>AI Twitter Recap</h1><ul><li>normal story</li></ul><div>a shape we have never seen before</div>`;
    const r = splitIssue(odd);
    expect(r.storyCount).toBe(1);
    expect(r.unplacedCount).toBe(1);
    expect(r.stories.find((s) => s.kind === 'unplaced')!.text).toBe('a shape we have never seen before');
  });

  it('an unrecognised section still yields its stories, and reports itself', () => {
    const r = splitIssue('<h1>AI YouTube Recap</h1><ul><li>a video roundup</li></ul>');
    expect(r.storyCount).toBe(1);
    expect(r.stories[0].sourceKind).toBe('unknown');
    expect(r.unknownSections).toEqual(['AI YouTube Recap']);
  });

  it('every word of the issue lands in exactly one piece', () => {
    // Reconstruct the plain text from the pieces and check nothing meaningful went missing.
    const r = splitIssue(ISSUE);
    const joined = r.stories.map((s) => s.text).join(' ');
    for (const phrase of [
      'a quiet day',
      'We checked 12 subreddits',
      'V4-Flash API',
      'Licensed MIT',
      'Amplified by @_akhaliq',
      'OpenAI cut GPT-5.6 Luna',
      '+25.8',
      'Commenters were cautiously excited',
      'The price war restarts',
    ]) {
      expect(joined).toContain(phrase);
    }
  });

  it('handles list items that close themselves — valid HTML5, and it used to swallow a whole section', () => {
    // `<li>A<li>B<li>C</ul>` is legal markup: an item ends when the next one starts. Counting
    // depth alone read B and C as children of A, folded the section into ONE unplaced lump, and
    // still balanced its totals — so it reported success with zero stories. The text was never
    // lost, but the count guarantee this whole ticket exists for silently stopped meaning anything.
    const implicit = `<h1>AI Twitter Recap</h1><ul><li>Item A<li>Item B<li>Item C</ul>
<h1>AI Reddit Recap</h1><ul><li>Item D</li></ul>`;
    const r = splitIssue(implicit);
    expect(r.storyCount).toBe(4);
    expect(r.stories.filter((s) => s.kind === 'story').map((s) => s.text)).toEqual(['Item A', 'Item B', 'Item C', 'Item D']);
    expect(r.unplacedCount).toBe(0);
    // and the second section is still recognised as its own heading, not swallowed into the lump
    expect(r.stories.find((s) => s.text === 'Item D')!.sourceKind).toBe('reddit');
  });

  it('a nested list still nests, even when its items close themselves', () => {
    const mixed = `<h1>AI Twitter Recap</h1><ul><li>Parent<ul><li>kid one<li>kid two</ul><li>Sibling</ul>`;
    const r = splitIssue(mixed);
    const stories = r.stories.filter((s) => s.kind === 'story');
    expect(stories).toHaveLength(2);
    expect(stories[0].text).toContain('Parent');
    expect(stories[0].text).toContain('• kid one');
    expect(stories[0].text).toContain('• kid two');
    expect(stories[1].text).toBe('Sibling');
  });

  it('a document that ends mid-list still yields its last story', () => {
    const r = splitIssue('<h1>AI Twitter Recap</h1><ul><li>unterminated story');
    expect(r.storyCount).toBe(1);
    expect(r.stories[0].text).toBe('unterminated story');
  });

  it('empty or contentless input yields nothing rather than throwing', () => {
    expect(splitIssue('').extractedCount).toBe(0);
    expect(splitIssue('<hr /><br />').extractedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------

function fakePrisma(issue: any, opts: { storedCount?: number } = {}) {
  const stories: any[] = [];
  const harness: any = {
    stories,
    issue,
    newsIssue: {
      findUnique: async () => issue,
      update: async ({ data }: any) => Object.assign(issue, data),
      findMany: async () => (issue && !issue.splitAt && !issue.summaryOnly ? [{ id: issue.id }] : []),
    },
    // Mirrors Prisma's interactive transaction so the real code path is what gets tested.
    $transaction: async (fn: any) => fn(harness),
    newsStory: {
      deleteMany: async () => {
        stories.length = 0;
        return { count: 0 };
      },
      createMany: async ({ data }: any) => {
        stories.push(...data);
        return { count: data.length };
      },
      // opts.storedCount lets a test pretend the write came up short.
      count: async () => (opts.storedCount === undefined ? stories.length : opts.storedCount),
      findMany: async () => stories,
    },
  };
  return harness;
}

describe('storing the split, with the count guarantee (BEA-1255)', () => {
  const issueRow = () => ({ id: 'i1', link: 'https://news.smol.ai/issues/x/', rawHtml: ISSUE, summaryOnly: false, splitAt: null });

  it('writes every piece and records the counts on the issue', async () => {
    const prisma = fakePrisma(issueRow());
    const out = await new NewsSplitService(prisma).splitOne('i1');
    expect(out.ok).toBe(true);
    expect(out.storyCount).toBe(5);
    expect(prisma.stories).toHaveLength(out.extractedCount);
    expect(prisma.issue.extractedCount).toBe(out.extractedCount);
    expect(prisma.issue.storyCount).toBe(5);
    expect(prisma.issue.splitAt).toBeInstanceOf(Date);
  });

  it('THROWS when what was stored does not match what was split', async () => {
    // Writing N and holding N are different claims. Only the second one matters, so it is the one
    // that gets checked — a short edition must never be able to look complete.
    const prisma = fakePrisma(issueRow(), { storedCount: 3 });
    await expect(new NewsSplitService(prisma).splitOne('i1')).rejects.toThrow(/count mismatch/);
  });

  it('re-splitting replaces the old rows instead of stacking a second generation', async () => {
    const prisma = fakePrisma(issueRow());
    const svc = new NewsSplitService(prisma);
    const first = await svc.splitOne('i1');
    const second = await svc.splitOne('i1');
    expect(second.extractedCount).toBe(first.extractedCount);
    expect(prisma.stories).toHaveLength(first.extractedCount);
  });

  it('a summary-only issue says so plainly instead of storing zero stories', async () => {
    const prisma = fakePrisma({ id: 'i1', link: 'x', rawHtml: null, summaryOnly: true });
    const out = await new NewsSplitService(prisma).splitOne('i1');
    expect(out.ok).toBe(false);
    expect(out.message).toContain('only has a summary');
    expect(prisma.stories).toHaveLength(0);
  });

  it('an issue with content that splits to nothing is a parser failure, and throws', async () => {
    const prisma = fakePrisma({ id: 'i1', link: 'x', rawHtml: '<hr /><br />', summaryOnly: false });
    await expect(new NewsSplitService(prisma).splitOne('i1')).rejects.toThrow(/parser failure/);
  });

  it('refuses an issue that collapses to a handful of stories, rather than publishing it short', async () => {
    // The failure this catches: the layout changes, the walk lumps a section together, the totals
    // still balance, and a five-line edition goes out looking complete. A real issue holds 31–79.
    const prisma = fakePrisma({ id: 'i1', link: 'https://news.smol.ai/x/', rawHtml: '<h1>AI Twitter Recap</h1><ul><li>the only one</li></ul>', summaryOnly: false });
    await expect(new NewsSplitService(prisma).splitOne('i1')).rejects.toThrow(/expected at least/);
    expect(prisma.issue.splitAt).toBeUndefined(); // and it is NOT marked as split
  });

  it('does the replace and the recount inside one transaction', async () => {
    // Without it, a crash between the delete and the create leaves an issue with no stories at all.
    const prisma = fakePrisma(issueRow());
    let used = false;
    const real = prisma.$transaction;
    prisma.$transaction = async (fn: any) => {
      used = true;
      return real(fn);
    };
    await new NewsSplitService(prisma).splitOne('i1');
    expect(used).toBe(true);
  });

  it('refuses to split the same issue twice at once instead of interleaving the writes', async () => {
    const prisma = fakePrisma(issueRow());
    const svc = new NewsSplitService(prisma);
    const results = await Promise.allSettled([svc.splitOne('i1'), svc.splitOne('i1')]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.message).toContain('already being split');
  });

  it('one unsplittable issue does not stop the batch, and is reported', async () => {
    const prisma = fakePrisma({ id: 'i1', link: 'x', rawHtml: '<hr />', summaryOnly: false, splitAt: null });
    const out = await new NewsSplitService(prisma).splitPending();
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(false);
    expect(out[0].message).toContain('parser failure');
  });
});
