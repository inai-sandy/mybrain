import { BadRequestException, Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { BookmarksService } from './bookmarks.service';
import { SummarizerService } from './summarizer.service';

@Controller('bookmarks')
export class BookmarksController {
  constructor(
    private readonly bookmarks: BookmarksService,
    private readonly summarizer: SummarizerService,
  ) {}

  /** Start a background sync of the last 3 months of Raindrop bookmarks. Returns immediately. */
  @Post('sync')
  async sync(@Body() body: { sinceDays?: number } = {}) {
    const res = await this.bookmarks.start({ sinceDays: body?.sinceDays });
    if (!res.ok) throw new BadRequestException(res.message || 'Sync failed');
    return res;
  }

  /** Live status: whether a sync is running + its progress, last-sync time, and total stored. */
  @Get('status')
  async status() {
    const st = this.bookmarks.getState();
    return { lastSync: await this.bookmarks.lastSync(), count: await this.bookmarks.count(), ...st };
  }

  /** The bookmarks-specific summarizer model (separate from the app's default AI model). */
  @Get('model')
  async getModel() {
    return this.summarizer.getModel();
  }

  @Put('model')
  async setModel(@Body() body: { model?: string }) {
    const model = (body?.model || '').trim();
    if (!model) throw new BadRequestException('Provide a model id');
    await this.summarizer.setModel(model);
    return { ok: true, provider: 'openrouter', model };
  }

  /** Every Gemini model available on OpenRouter, for the bookmarks model picker. */
  @Get('models')
  async models() {
    return { models: await this.summarizer.listGeminiModels() };
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
