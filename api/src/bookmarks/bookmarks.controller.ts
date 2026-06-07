import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BookmarksService } from './bookmarks.service';

@Controller('bookmarks')
export class BookmarksController {
  constructor(private readonly bookmarks: BookmarksService) {}

  /** Pull the last 3 months of Raindrop bookmarks, read + summarize, index as "bookmark". */
  @Post('sync')
  async sync(@Body() body: { sinceDays?: number; cap?: number } = {}) {
    const res = await this.bookmarks.sync({ sinceDays: body?.sinceDays, cap: body?.cap });
    if (!res.ok) throw new BadRequestException(res.message || 'Sync failed');
    return res;
  }

  /** Last-sync time + how many bookmarks are stored. */
  @Get('status')
  async status() {
    return { lastSync: await this.bookmarks.lastSync(), count: await this.bookmarks.count() };
  }

  /** Find bookmarks by meaning (ranked list of links + descriptions). */
  @Get('search')
  async search(@Query('q') q: string) {
    return { items: await this.bookmarks.search(q || '') };
  }

  /** Browse all stored bookmarks. */
  @Get()
  async list() {
    return { items: await this.bookmarks.listItems() };
  }
}
