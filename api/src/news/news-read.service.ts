import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NEWS_CATEGORIES, UNCATEGORISED } from './news-categorise.service';

/**
 * Reading an edition (BEA-1260).
 *
 * One call returns everything a page needs: the written sections, every story under each of them,
 * the shortlist, and the counts. Complete coverage is the whole promise, so the page is given all
 * 31–79 stories at once and decides how much to show — it never fetches "more" later, because a
 * story behind a second request is a story that can go missing when that request fails.
 */

export type EditionStory = {
  id: string;
  text: string;
  /** Written by the engine (BEA-1267); null falls back to the first sentence on the page. */
  headline: string | null;
  theme: string | null;
  category: string;
  sourceKind: string;
  links: string[];
  flagged: boolean;
};

@Injectable()
export class NewsReadService {
  constructor(private readonly prisma: PrismaService) {}

  private parse<T>(raw: string | null | undefined, fallback: T): T {
    try {
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  /** Every edition, newest first — the archive. */
  async list(limit = 60) {
    const rows = await this.prisma.newsEdition.findMany({
      where: { published: true },
      orderBy: { day: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map((e) => ({
      number: e.number,
      day: e.day,
      headline: e.headline,
      storyCount: e.storyCount,
      engineOk: e.engineOk,
      sixty: this.parse<string[]>(e.sixty, []),
      categories: this.parse<any[]>(e.sections, []).map((s) => ({ category: s.category, count: s.storyCount })),
      createdAt: e.createdAt,
    }));
  }

  /** The newest edition's day, so the page knows where to land. */
  async latestDay(): Promise<string | null> {
    const row = await this.prisma.newsEdition.findFirst({ where: { published: true }, orderBy: { day: 'desc' }, select: { day: true } });
    return row?.day || null;
  }

  /**
   * One whole edition. `day` is YYYY-MM-DD and is also its public address.
   *
   * Every story is included, under its category, in the order it appeared in the source. A category
   * the engine could not write still carries its stories — that is what makes an engine failure a
   * plainer edition rather than a shorter one.
   */
  async byDay(day: string) {
    // `published` guarded here too, like list() and latestDay(). Today every written edition is
    // published, but a draft leaking by URL guess is exactly the kind of thing that stops being
    // impossible the moment that invariant changes.
    const edition = await this.prisma.newsEdition.findFirst({ where: { day, published: true } });
    if (!edition) throw new NotFoundException('No edition for that day');

    const issue = await this.prisma.newsIssue.findUnique({
      where: { id: edition.issueId },
      select: { title: true, link: true, pubDate: true },
    });
    const rows = await this.prisma.newsStory.findMany({
      where: { issueId: edition.issueId, kind: 'story' },
      orderBy: { order: 'asc' },
      select: { id: true, text: true, theme: true, category: true, sourceKind: true, links: true, flagged: true, headline: true },
    });

    const stories: EditionStory[] = rows.map((s) => ({
      id: s.id,
      text: s.text,
      headline: s.headline,
      theme: s.theme,
      category: s.category || UNCATEGORISED,
      sourceKind: s.sourceKind,
      links: this.parse<string[]>(s.links, []),
      flagged: s.flagged,
    }));

    const written = this.parse<any[]>(edition.sections, []);
    const byCategory = new Map<string, EditionStory[]>();
    for (const s of stories) {
      if (!byCategory.has(s.category)) byCategory.set(s.category, []);
      byCategory.get(s.category)!.push(s);
    }

    // Written sections first, in the fixed order. Then any category that somehow has stories but no
    // written section — visible rather than quietly missing, which is the point of the whole thing.
    // Any category we do not recognise goes on the END rather than being skipped. A story dropped
    // here would still be counted in storyCount — the page would flag itself incomplete but the
    // story itself would be unreachable on both axes, which is precisely the loss this whole
    // feature exists to prevent.
    const known = NEWS_CATEGORIES.filter((c) => byCategory.has(c));
    const unknown = [...byCategory.keys()].filter((c) => !(NEWS_CATEGORIES as readonly string[]).includes(c));
    const sections = [...known, ...unknown].map((category) => {
      const w = written.find((x) => x.category === category);
      const mine = byCategory.get(category)!;
      return {
        category,
        line: w?.line || `${mine.length} ${mine.length === 1 ? 'story' : 'stories'}`,
        prose: w?.prose || '',
        written: Boolean(w?.written),
        storyCount: mine.length,
        stories: mine,
      };
    });

    const bySource = stories.reduce<Record<string, number>>((acc, s) => {
      acc[s.sourceKind] = (acc[s.sourceKind] || 0) + 1;
      return acc;
    }, {});

    // The count the page prints. If these ever disagree, the page says so rather than quietly
    // showing fewer stories than the edition claims.
    const shown = sections.reduce((n, s) => n + s.stories.length, 0);

    return {
      number: edition.number,
      day: edition.day,
      headline: edition.headline,
      sixty: this.parse<string[]>(edition.sixty, []),
      engineOk: edition.engineOk,
      notes: this.parse<string[]>(edition.notes, []),
      storyCount: edition.storyCount,
      shown,
      complete: shown === edition.storyCount,
      sections,
      flagged: stories.filter((s) => s.flagged),
      bySource,
      source: issue ? { title: issue.title, link: issue.link, pubDate: issue.pubDate } : null,
    };
  }
}
