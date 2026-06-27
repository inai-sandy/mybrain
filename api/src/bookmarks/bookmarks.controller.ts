import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BookmarksService } from './bookmarks.service';
import { SummarizerService } from './summarizer.service';

@Controller('bookmarks')
export class BookmarksController {
  constructor(
    private readonly bookmarks: BookmarksService,
    private readonly summarizer: SummarizerService,
  ) {}

  /** Serve a bookmark's cached image (downloaded so Instagram URLs can't expire). (BEA-609) */
  @Get(':id/image')
  async image(@Param('id') id: string, @Res() res: Response) {
    const f = await this.bookmarks.imageFile(id);
    if (!f) throw new NotFoundException('No cached image');
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(f);
  }

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

  /** Raindrop auto-sync config (default ON, hourly). */
  @Get('autosync')
  async getAutoSync() {
    return this.bookmarks.getAutoSync();
  }

  @Put('autosync')
  async setAutoSync(@Body() body: { enabled?: boolean; intervalMinutes?: number }) {
    await this.bookmarks.setAutoSync(body?.enabled ?? true, body?.intervalMinutes ?? 60);
    return { ok: true, ...(await this.bookmarks.getAutoSync()) };
  }

  /** Re-write every bookmark's memory (crawl-safe) so all land correctly in both stores. */
  @Post('reindex-memory')
  async reindexMemory() {
    return this.bookmarks.reindexMemory();
  }

  /** Backfill cover/YouTube thumbnails for existing bookmarks. */
  @Post('backfill-thumbnails')
  async backfillThumbnails() {
    return this.bookmarks.backfillThumbnails();
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
