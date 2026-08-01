import { Controller, Get, Post, Query } from '@nestjs/common';
import { NewsFeedService } from './news-feed.service';

@Controller('news')
export class NewsController {
  constructor(private readonly feed: NewsFeedService) {}

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
}
