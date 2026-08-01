import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NewsFeedService } from './news-feed.service';
import { NewsSplitService } from './news-split.service';
import { NewsCategoriseService } from './news-categorise.service';
import { NewsWriteService } from './news-write.service';
import { NewsResearchService } from './news-research.service';

/**
 * The three steps of AI News Daily, as things a flow can run (BEA-1259).
 *
 * They exist so the canvas can SHOW the pipeline — collect, write, flag — while the work itself
 * stays in our own code. An engine turn averages 118,000 tokens; fetching an RSS feed and counting
 * list items should not cost that, and more importantly the engine must not be the thing deciding
 * whether a story was kept.
 *
 * Each step is safe to run again and reports what it actually did. A step that fails THROWS with a
 * plain reason, so the run is marked failed instead of the flow carrying on to write an edition
 * from stories that were never collected.
 */
@Injectable()
export class NewsPipelineService {
  private readonly log = new Logger('NewsPipeline');

  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: NewsFeedService,
    private readonly split: NewsSplitService,
    private readonly categorise: NewsCategoriseService,
    private readonly write: NewsWriteService,
    private readonly research: NewsResearchService,
  ) {}

  /** The newest issue we can actually build an edition from. */
  private async latestUsable() {
    return this.prisma.newsIssue.findFirst({
      where: { summaryOnly: false },
      orderBy: { pubDate: 'desc' },
    });
  }

  /**
   * Step 1 — collect. Pull the feed, split every new issue into its stories, and sort them into
   * categories. Free apart from the categorising, which is one small batched call.
   */
  async collect(): Promise<string> {
    const poll = await this.feed.poll();
    if (!poll.ok) throw new Error(`could not collect the news: ${poll.message || 'the feed did not come back'}`);

    const splits = await this.split.splitPending();
    const failedSplits = splits.filter((s) => !s.ok && !String(s.message || '').includes('only has a summary'));

    const issue = await this.latestUsable();
    if (!issue) throw new Error('no usable issue in the feed yet — nothing to build an edition from');

    const cat = await this.categorise.categoriseIssue(issue.id);
    if (!cat.ok) throw new Error(`could not sort the stories into categories: ${cat.message}`);

    const lines = [
      `Collected today's AI news.`,
      `Issue: ${issue.title} (${new Date(issue.pubDate).toISOString().slice(0, 10)})`,
      `Stories found: ${cat.total} — every one filed into a category.`,
      cat.uncategorised ? `${cat.uncategorised} could not be placed and are showing as Uncategorised.` : `None left uncategorised.`,
      splits.length ? `Issues split this run: ${splits.filter((s) => s.ok).length}.` : '',
      failedSplits.length ? `WARNING: ${failedSplits.length} issue(s) could not be split — ${failedSplits.map((s) => s.message).join('; ')}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  /** Step 2 — write. Codex turns the categorised stories into the day's edition. */
  async writeToday(): Promise<string> {
    const issue = await this.latestUsable();
    if (!issue) throw new Error('there is no collected issue to write about — run the collect step first');

    const ed = await this.write.publishEdition(issue.id);
    const lines = [
      `Wrote AI News Daily No. ${ed.number} for ${ed.day}.`,
      `${ed.storyCount} stories, all of them in the edition.`,
      ed.engineOk
        ? `Every section was written.`
        : `NOT every section was written — the edition still carries every story and every link, and says so on the page.`,
      ...ed.notes.map((n) => `- ${n}`),
    ];
    return lines.join('\n');
  }

  /** Step 3 — flag. Pick the few stories worth a proper dig. */
  async flagToday(): Promise<string> {
    const issue = await this.latestUsable();
    if (!issue) throw new Error('there is no collected issue to look through — run the collect step first');

    const out = await this.research.flagIssue(issue.id);
    if (!out.ok) {
      // Not fatal: the edition is fine, the shortlist just is not there. Say so rather than
      // failing the whole run over a nice-to-have.
      return `Could not work out what is worth researching. ${out.message}`;
    }
    return out.flagged
      ? `${out.flagged} of ${out.considered} stories look worth digging into. They are listed at the end of the edition, and every other story still has its own research button.`
      : `Nothing today needs chasing — a clean day. Every story still has its own research button if you disagree.`;
  }

  /** All three, in order — what the scheduled flow does every day at noon. */
  async runDaily(): Promise<string> {
    const out: string[] = [];
    out.push(await this.collect());
    out.push(await this.writeToday());
    out.push(await this.flagToday());
    return out.join('\n\n');
  }
}
