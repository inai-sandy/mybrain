import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FeedItem, parseFeed } from './feed-parse';

export type PollResult = {
  ok: boolean;
  /** Items the feed offered us. */
  fetched: number;
  /** Issues stored for the first time. */
  stored: number;
  /** Issues we already had and left alone. */
  known: number;
  /** Issues we had as summary-only that have now gained their full content. */
  filled: number;
  /** Items with no link — no identity, so unstorable. Counted, never hidden. */
  unusable: number;
  /** Issues the feed gave us that we could not write down. Never silently zero. */
  failed?: number;
  message?: string;
};

/**
 * Fetches https://news.smol.ai/rss.xml and keeps every issue (BEA-1254).
 *
 * Storing everything as it appears is what makes the daily edition safe: the source publishes at
 * 11:14 am IST but that can drift, and an edition simply covers everything since the last one, so
 * the publish time cannot cause a miss either way.
 *
 * No AI runs here at all. This is a fetch and a write.
 */
@Injectable()
export class NewsFeedService implements OnModuleInit, OnModuleDestroy {
  static readonly FEED_URL = 'https://news.smol.ai/rss.xml';
  /** One issue a day, and the feed holds ~688 back-issues, so nothing can roll off. Hourly is plenty. */
  static readonly POLL_MS = 60 * 60 * 1000;

  private readonly log = new Logger('NewsFeed');
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    // Poll once on boot as well as hourly. Deploys restart the container often here, and without
    // this the table would sit empty (or an hour stale) after every single deploy.
    this.poll().catch((e) => this.log.error(`first poll failed: ${e?.message || e}`));
    this.timer = setInterval(() => {
      this.poll().catch((e) => this.log.error(`poll failed: ${e?.message || e}`));
    }, NewsFeedService.POLL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Overridable in tests so the pipeline can be exercised without the network. */
  protected async fetchXml(): Promise<string> {
    const res = await fetch(NewsFeedService.FEED_URL, {
      signal: AbortSignal.timeout(45_000),
      headers: { 'user-agent': 'mybrain-news/1.0 (+https://mybrain.1site.ai)' },
    });
    if (!res.ok) throw new Error(`feed returned ${res.status}`);
    return res.text();
  }

  /**
   * Pull the feed and store what is new.
   *
   * A bad fetch or unparseable feed returns ok:false and touches nothing. It must never quietly
   * become an empty edition — a day with no news and a day we failed to fetch look identical from
   * the outside, and only one of them is fine.
   */
  async poll(): Promise<PollResult> {
    // Two polls at once (the hourly timer meeting a hand-triggered "pull now") would both see an
    // issue as missing and both try to create it, colliding on the unique link. Serialise instead.
    if (this.polling) {
      return { ok: true, fetched: 0, stored: 0, known: 0, filled: 0, unusable: 0, message: 'a poll is already running' };
    }
    this.polling = true;
    try {
      return await this.runPoll();
    } finally {
      this.polling = false;
    }
  }

  private async runPoll(): Promise<PollResult> {
    let xml: string;
    try {
      xml = await this.fetchXml();
    } catch (e: any) {
      const message = `could not fetch the feed: ${e?.message || e}`;
      this.log.error(message);
      return { ok: false, fetched: 0, stored: 0, known: 0, filled: 0, unusable: 0, message };
    }

    const items = parseFeed(xml);
    if (!items.length) {
      // A feed that parses to nothing is a broken feed, not a quiet day. Say so and change nothing.
      const message = 'the feed parsed to zero issues — leaving stored issues untouched';
      this.log.error(message);
      return { ok: false, fetched: 0, stored: 0, known: 0, filled: 0, unusable: 0, message };
    }

    const rawItemCount = (xml.match(/<item(?:\s[^>]*)?>/g) || []).length;
    let stored = 0;
    let known = 0;
    let filled = 0;
    const failed: string[] = [];

    for (const item of items) {
      try {
        const outcome = await this.store(item);
        if (outcome === 'stored') stored++;
        else if (outcome === 'filled') filled++;
        else known++;
      } catch (e: any) {
        // One bad row must not abandon the rest of the feed half-stored. Skip it, keep going, and
        // report it — a silently short poll is exactly the failure this feature cannot afford.
        failed.push(item.link);
        this.log.error(`could not store ${item.link}: ${e?.message || e}`);
      }
    }

    if (stored || filled) {
      // Recording when new issues actually land turns "it publishes around 11am" from a guess into
      // a fact after a week of logs.
      this.log.log(`new issues: ${stored} stored, ${filled} filled in (feed had ${items.length})`);
    }
    return {
      ok: failed.length === 0,
      fetched: items.length,
      stored,
      known,
      filled,
      unusable: Math.max(0, rawItemCount - items.length),
      failed: failed.length,
      message: failed.length ? `${failed.length} issue(s) could not be stored: ${failed.slice(0, 3).join(', ')}` : undefined,
    };
  }

  /**
   * Store one issue. Never overwrites content we already hold: an issue drops out of the feed's
   * newest ten and comes back summary-only, and blindly upserting would erase the full text we
   * need to build editions from.
   */
  private async store(item: FeedItem): Promise<'stored' | 'filled' | 'known'> {
    const existing = await this.prisma.newsIssue.findUnique({ where: { link: item.link } });
    const entities = JSON.stringify(item.entities);

    if (!existing) {
      await this.prisma.newsIssue.create({
        data: {
          link: item.link,
          title: item.title,
          pubDate: item.pubDate || new Date(),
          description: item.description,
          rawHtml: item.contentHtml,
          entities,
          summaryOnly: !item.contentHtml,
          filledAt: item.contentHtml ? new Date() : null,
        },
      });
      return 'stored';
    }

    if (existing.summaryOnly && item.contentHtml) {
      await this.prisma.newsIssue.update({
        where: { id: existing.id },
        data: { rawHtml: item.contentHtml, summaryOnly: false, filledAt: new Date(), entities, fetchedAt: new Date() },
      });
      return 'filled';
    }

    return 'known';
  }

  /** Issues we can actually build an edition from, newest first. */
  async usableIssues(take = 30) {
    return this.prisma.newsIssue.findMany({
      where: { summaryOnly: false },
      orderBy: { pubDate: 'desc' },
      take,
      select: { id: true, link: true, title: true, pubDate: true, description: true, entities: true },
    });
  }
}
