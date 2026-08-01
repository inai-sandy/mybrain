import { decodeEntities } from './feed-parse';

/**
 * Split one Smol AI issue into its individual news items (BEA-1255).
 *
 * The owner's hardest requirement is "categorize without missing any news article in it". That is
 * why this splits with CODE rather than a model: a structural split can be counted, and an AI split
 * cannot. Everything downstream asserts against the counts this produces.
 *
 * **Nothing is discarded.** Every piece of text in the issue lands in exactly one piece:
 *   - `story`    — a TOP-LEVEL <li>. This is the unit of news, and it carries its nested
 *                  sub-bullets inside its own text.
 *   - `theme`    — a <p> sitting outside any list, under a heading. A section label, not news.
 *   - `intro`    — the masthead blockquote before the first <h1> ("We checked 12 subreddits…").
 *   - `unplaced` — anything else with text in it. This bucket exists so that a shape we have never
 *                  seen shows up **visibly** instead of vanishing. It should normally be empty.
 * Because the leftovers become `unplaced` rather than being dropped, coverage is total by
 * construction — there is no silent remainder.
 *
 * Measured across all 10 full issues on 2026-08-01: 31–79 stories each, mean 40.
 *
 * A plain /<li>(.*?)<\/li>/ regex is WRONG here and was the first thing I got wrong: lists nest
 * (17 of the 40 stories in the 31 Jul issue contain a nested <ul>), so a lazy match ends at the
 * CHILD's closing tag and truncates the parent story. Hence the depth-aware walk below.
 */

export type StoryKind = 'story' | 'theme' | 'intro' | 'unplaced';
export type SourceKind = 'twitter' | 'reddit' | 'discord' | 'unknown';

export type RawStory = {
  order: number;
  kind: StoryKind;
  sourceKind: SourceKind;
  /** "AI Reddit Recap › /r/LocalLlama Recap › 1. DeepSeek V4-Flash" — where in the issue it sat. */
  sectionPath: string;
  /** The nearest theme paragraph above it, when there is one. */
  theme: string | null;
  text: string;
  html: string;
  links: string[];
};

export type SplitResult = {
  stories: RawStory[];
  /** Just the `story` items — what the edition is built from. */
  storyCount: number;
  /** Every piece, whatever its kind. The number later stages must not change. */
  extractedCount: number;
  /** Headings we did not recognise as a source. Empty is the happy case; non-empty is a signal. */
  unknownSections: string[];
  /** Text that fell outside every known shape. Should be 0; anything else wants a look. */
  unplacedCount: number;
};

/** Which recap a heading belongs to. New sections fall through to `unknown` and are reported. */
export function sourceOf(h1: string): SourceKind {
  const h = h1.toLowerCase();
  if (h.includes('twitter') || h.includes(' x ') || h.startsWith('x ')) return 'twitter';
  if (h.includes('reddit') || h.includes('/r/')) return 'reddit';
  if (h.includes('discord')) return 'discord';
  return 'unknown';
}

/** Tags whose closing edge should read as a line break when flattening HTML to text. */
const BREAK_AFTER = new Set(['p', 'li', 'div', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'tr', 'br']);

/**
 * Flatten a fragment of HTML to readable plain text. Nested bullets survive as "• " lines so a
 * story keeps its detail instead of running together into one blob.
 */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<li(?:\s[^>]*)?>/gi, '\n• ');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?\/?>/g, (whole, name: string) =>
    BREAK_AFTER.has(name.toLowerCase()) ? '\n' : '',
  );
  s = decodeEntities(s);
  return s
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Every href in a fragment, in order, de-duplicated. */
export function linksIn(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const href = decodeEntities(m[1] ?? m[2] ?? '').trim();
    if (!href || seen.has(href) || href.startsWith('#')) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

type Tag = { name: string; close: boolean; start: number; end: number };

function* walk(html: string): Generator<Tag> {
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)(?:\s[^>]*)?>/g)) {
    yield { name: m[2].toLowerCase(), close: m[1] === '/', start: m.index!, end: m.index! + m[0].length };
  }
}

/**
 * The split itself.
 *
 * Walks the document once, tracking list depth and the current h1/h2/h3. A top-level <li> opens a
 * story; the matching close (at depth 0 again) ends it. Text outside any list becomes a theme, an
 * intro, or — if it fits nothing — an `unplaced` item, so the remainder is never silently zero.
 */
export function splitIssue(rawHtml: string): SplitResult {
  const html = rawHtml || '';
  const stories: RawStory[] = [];
  const unknownSections: string[] = [];

  let h1 = '';
  let h2 = '';
  let h3 = '';
  let theme: string | null = null;
  let seenFirstHeading = false;

  /**
   * Open list items, innermost last, each remembering how many <ul>/<ol> were open when it started.
   *
   * A plain depth counter is not enough: HTML5 lets a list item close ITSELF when the next one
   * begins, so `<ul><li>A<li>B<li>C</ul>` is valid markup with three siblings. Counting depth alone
   * reads B and C as children of A, folds the whole section into one lump, and — because the total
   * still balances — reports success with zero stories. Tracking which list level each open item
   * belongs to lets a sibling, a `</ul>`, or an explicit `</li>` all close it correctly.
   */
  const liStack: { listDepth: number }[] = [];
  let listDepth = 0;
  let storyStart = -1;
  /** Where the last captured region ended — everything before it is already accounted for. */
  let consumedTo = 0;

  const sectionPath = () => [h1, h2, h3].filter(Boolean).join(' › ');

  const push = (kind: StoryKind, fragment: string, from: number, to: number) => {
    const text = htmlToText(fragment);
    if (!text) return;
    stories.push({
      order: stories.length,
      kind,
      sourceKind: h1 ? sourceOf(h1) : 'unknown',
      sectionPath: sectionPath(),
      theme: kind === 'story' ? theme : null,
      text,
      html: fragment.trim(),
      links: linksIn(fragment),
    });
    consumedTo = Math.max(consumedTo, to);
    void from;
  };

  /**
   * Anything between the last captured region and `upto` that still has words in it. This is the
   * safety net: a shape we have never seen becomes a visible `unplaced` item rather than a gap.
   */
  const sweep = (upto: number) => {
    if (upto <= consumedTo) return;
    const gap = html.slice(consumedTo, upto);
    const text = htmlToText(gap);
    consumedTo = upto;
    if (!text) return;
    stories.push({
      order: stories.length,
      kind: seenFirstHeading ? 'unplaced' : 'intro',
      sourceKind: h1 ? sourceOf(h1) : 'unknown',
      sectionPath: sectionPath(),
      theme: null,
      text,
      html: gap.trim(),
      links: linksIn(gap),
    });
  };

  /** Finish the outermost open item: that is one whole story. */
  const closeStory = (at: number) => {
    if (storyStart < 0) return;
    push('story', html.slice(storyStart, at), storyStart, at);
    storyStart = -1;
  };

  /** Pop every open item that lives at `atOrDeeperThan` or deeper, closing the story if we empty out. */
  const closeItemsAtOrDeeper = (atOrDeeperThan: number, pos: number) => {
    while (liStack.length && liStack[liStack.length - 1].listDepth >= atOrDeeperThan) {
      liStack.pop();
      if (liStack.length === 0) closeStory(pos);
    }
  };

  const tags = [...walk(html)];
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];

    if (t.name === 'ul' || t.name === 'ol') {
      if (t.close) {
        // A closing list ends anything still open inside it, closed tag or not.
        closeItemsAtOrDeeper(listDepth, t.start);
        listDepth = Math.max(0, listDepth - 1);
      } else {
        listDepth++;
      }
      continue;
    }

    if (t.name === 'li') {
      if (!t.close) {
        // An item at the same list level as one already open closes it — HTML5's implicit close.
        closeItemsAtOrDeeper(listDepth, t.start);
        if (liStack.length === 0) {
          sweep(t.start); // whatever sat between the last capture and this story
          storyStart = t.end;
        }
        liStack.push({ listDepth });
      } else if (liStack.length) {
        liStack.pop();
        if (liStack.length === 0) closeStory(t.start);
      }
      continue;
    }

    if (liStack.length > 0) continue; // inside a story — its own markup belongs to it

    // A heading resets the theme and moves us down the section path.
    if ((t.name === 'h1' || t.name === 'h2' || t.name === 'h3') && !t.close) {
      const close = tags.slice(i + 1).find((x) => x.name === t.name && x.close);
      const inner = html.slice(t.end, close ? close.start : t.end);
      const label = htmlToText(inner);
      sweep(t.start);
      consumedTo = close ? close.end : t.end;
      seenFirstHeading = true;
      theme = null;
      if (t.name === 'h1') {
        h1 = label;
        h2 = '';
        h3 = '';
        if (sourceOf(label) === 'unknown' && label) unknownSections.push(label);
      } else if (t.name === 'h2') {
        h2 = label;
        h3 = '';
      } else {
        h3 = label;
      }
      continue;
    }

    // A paragraph outside any list, after the first heading, is a section theme.
    if (t.name === 'p' && !t.close && seenFirstHeading) {
      const close = tags.slice(i + 1).find((x) => x.name === 'p' && x.close);
      if (!close) continue;
      const inner = html.slice(t.end, close.start);
      const label = htmlToText(inner);
      if (label) {
        sweep(t.start);
        theme = label;
        push('theme', inner, t.end, close.end);
      }
    }
  }

  closeItemsAtOrDeeper(0, html.length); // a document that ends mid-list still yields its last story
  sweep(html.length); // and the tail

  return {
    stories,
    storyCount: stories.filter((s) => s.kind === 'story').length,
    extractedCount: stories.length,
    unknownSections,
    unplacedCount: stories.filter((s) => s.kind === 'unplaced').length,
  };
}
