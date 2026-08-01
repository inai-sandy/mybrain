import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { splitIssue } from './split-issue';

export type SplitOutcome = {
  ok: boolean;
  issueId: string;
  storyCount: number;
  extractedCount: number;
  unplacedCount: number;
  unknownSections: string[];
  message?: string;
};

/**
 * Splits a stored issue into its news items and writes them down (BEA-1255).
 *
 * The count guarantee lives here. `extractedCount` is written on the issue, every row is counted
 * back out of the database after writing, and a disagreement THROWS. The owner's requirement is
 * "without missing any news article in it", and the only way to keep that promise is to make a
 * short result impossible to mistake for a complete one.
 */
@Injectable()
export class NewsSplitService {
  /**
   * The floor a real issue must clear. Measured across every full issue in the feed on 2026-08-01:
   * 31–79 stories each, mean 40. Set well below the observed minimum so a genuinely quiet day still
   * publishes, while a structural collapse cannot pass as one.
   */
  static readonly MIN_STORIES = 5;

  private readonly log = new Logger('NewsSplit');
  /** Issues being split right now — a re-split racing the batch would interleave its writes. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Run in a real transaction when Prisma offers one; spec harnesses pass partial stubs. */
  private async inTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const run = (this.prisma as any).$transaction;
    if (typeof run !== 'function') return fn(this.prisma);
    return run.call(this.prisma, fn);
  }

  /**
   * Split one issue. Safe to run again: the issue's existing stories are replaced, so a re-split
   * after a parser fix cannot leave two generations of rows behind.
   */
  async splitOne(issueId: string): Promise<SplitOutcome> {
    if (this.inFlight.has(issueId)) {
      throw new Error(`this issue is already being split — wait for that to finish rather than racing it`);
    }
    this.inFlight.add(issueId);
    try {
      return await this.runSplit(issueId);
    } finally {
      this.inFlight.delete(issueId);
    }
  }

  private async runSplit(issueId: string): Promise<SplitOutcome> {
    const issue = await this.prisma.newsIssue.findUnique({ where: { id: issueId } });
    if (!issue) throw new Error(`no such issue: ${issueId}`);
    if (!issue.rawHtml) {
      // Summary-only issues carry no content to split. Say so plainly rather than writing zero
      // stories and letting it look like a quiet day.
      return {
        ok: false,
        issueId,
        storyCount: 0,
        extractedCount: 0,
        unplacedCount: 0,
        unknownSections: [],
        message: 'this issue only has a summary, not the full text — nothing to split',
      };
    }

    const split = splitIssue(issue.rawHtml);
    if (!split.extractedCount) {
      throw new Error(`split produced nothing for ${issue.link} — the issue has content, so this is a parser failure`);
    }

    // A real issue holds 31–79 stories (measured across every full issue in the feed). Landing far
    // under that means the shape changed and the walk lumped a section together — the text is all
    // still there as `unplaced`, so the totals balance and nothing downstream would notice. The
    // count guarantee only means something if a collapse like that is loud.
    if (split.storyCount < NewsSplitService.MIN_STORIES) {
      throw new Error(
        `only ${split.storyCount} stor${split.storyCount === 1 ? 'y' : 'ies'} found in ${issue.link} ` +
          `(expected at least ${NewsSplitService.MIN_STORIES}, and ${split.unplacedCount} piece(s) fitted no known shape) — ` +
          `the issue layout has probably changed; refusing to publish a short edition`,
      );
    }

    const rows = split.stories.map((s) => ({
      issueId,
      order: s.order,
      kind: s.kind,
      sourceKind: s.sourceKind,
      sectionPath: s.sectionPath,
      theme: s.theme,
      text: s.text,
      html: s.html,
      links: JSON.stringify(s.links),
    }));

    // Replace + recount in ONE transaction. Without it a crash between the two leaves an issue with
    // no stories at all, and two overlapping re-splits can interleave into a mixed set of rows whose
    // total still happens to match — passing the count check while holding something neither run
    // intended.
    const written = await this.inTransaction(async (tx) => {
      await tx.newsStory.deleteMany({ where: { issueId } });
      await tx.newsStory.createMany({ data: rows });
      // Count them back OUT of the database. Writing N and holding N are different claims, and only
      // the second one matters.
      return tx.newsStory.count({ where: { issueId } });
    });
    if (written !== split.extractedCount) {
      throw new Error(
        `count mismatch for ${issue.link}: split produced ${split.extractedCount} pieces but ${written} were stored — refusing to continue`,
      );
    }

    await this.prisma.newsIssue.update({
      where: { id: issueId },
      data: { extractedCount: split.extractedCount, storyCount: split.storyCount, splitAt: new Date() },
    });

    if (split.unknownSections.length) {
      this.log.warn(`${issue.link}: unrecognised section(s) ${split.unknownSections.join(', ')} — stories kept, source marked unknown`);
    }
    if (split.unplacedCount) {
      this.log.warn(`${issue.link}: ${split.unplacedCount} piece(s) of text fitted no known shape — kept as 'unplaced' so they stay visible`);
    }

    return {
      ok: true,
      issueId,
      storyCount: split.storyCount,
      extractedCount: split.extractedCount,
      unplacedCount: split.unplacedCount,
      unknownSections: split.unknownSections,
    };
  }

  /** Split every stored issue that has content and has not been split yet. */
  async splitPending(limit = 20): Promise<SplitOutcome[]> {
    const pending = await this.prisma.newsIssue.findMany({
      where: { summaryOnly: false, splitAt: null },
      orderBy: { pubDate: 'desc' },
      take: limit,
      select: { id: true },
    });
    const out: SplitOutcome[] = [];
    for (const p of pending) {
      try {
        out.push(await this.splitOne(p.id));
      } catch (e: any) {
        // One unsplittable issue must not stop the rest, but it is reported, never swallowed.
        this.log.error(`split failed for ${p.id}: ${e?.message || e}`);
        out.push({
          ok: false,
          issueId: p.id,
          storyCount: 0,
          extractedCount: 0,
          unplacedCount: 0,
          unknownSections: [],
          message: e?.message || String(e),
        });
      }
    }
    return out;
  }

  /** The news items of one issue, in the order they appeared. */
  async storiesFor(issueId: string, kind?: string) {
    return this.prisma.newsStory.findMany({
      where: { issueId, ...(kind ? { kind } : {}) },
      orderBy: { order: 'asc' },
    });
  }
}
