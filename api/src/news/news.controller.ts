import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { NewsFeedService } from './news-feed.service';
import { NewsSplitService } from './news-split.service';
import { NewsCategoriseService } from './news-categorise.service';

@Controller('news')
export class NewsController {
  constructor(
    private readonly feed: NewsFeedService,
    private readonly split: NewsSplitService,
    private readonly categorise: NewsCategoriseService,
  ) {}

  /** Pull the feed now instead of waiting for the hourly poll. (BEA-1254) */
  @Post('poll')
  poll() {
    return this.feed.poll();
  }

  /** Issues we hold that an edition can actually be built from, newest first. */
  @Get('issues')
  issues(@Query('take') take?: string) {
    // `?take=abc` would otherwise reach Prisma as NaN and come back as a raw 500.
    const n = Number(take);
    const safe = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 200) : 30;
    return this.feed.usableIssues(safe);
  }

  /** Split every stored issue that has content and has not been split yet. (BEA-1255) */
  @Post('split')
  splitPending() {
    return this.split.splitPending();
  }

  /** Re-split one issue — safe to repeat, it replaces that issue's rows. (BEA-1255) */
  @Post('issues/:id/split')
  splitOne(@Param('id') id: string) {
    return this.split.splitOne(id);
  }

  /** Sort one issue's stories into the eight fixed categories. (BEA-1256) */
  @Post('issues/:id/categorise')
  categoriseOne(@Param('id') id: string) {
    return this.categorise.categoriseIssue(id);
  }

  /** How one issue's stories are spread across the categories. (BEA-1256) */
  @Get('issues/:id/breakdown')
  breakdown(@Param('id') id: string) {
    return this.categorise.breakdown(id);
  }

  /** The pieces of one issue, in the order they appeared. `?kind=story` for just the news. */
  @Get('issues/:id/stories')
  stories(@Param('id') id: string, @Query('kind') kind?: string) {
    return this.split.storiesFor(id, kind || undefined);
  }
}
