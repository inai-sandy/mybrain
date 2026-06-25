import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DocumentsService, DocInput } from './documents.service';
import { Public } from '../auth/public.decorator';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get()
  list() {
    return this.docs.list();
  }

  @Post()
  create(@Body() body: DocInput) {
    return this.docs.create(body || {});
  }

  /** AI: suggest a description + tags for the editor's "Auto-fill" button. */
  @Post('summarize')
  summarize(@Body() body: { contentText?: string }) {
    return this.docs.summarize(body?.contentText || '');
  }

  /** Public read of a shared document by slug (no login). Must be declared before ':id'. */
  @Public()
  @Get('public/:slug')
  async public(@Param('slug') slug: string) {
    const d = await this.docs.getShared(slug);
    if (!d) throw new NotFoundException('This document is not shared (or no longer shared).');
    return d;
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const d = await this.docs.get(id);
    if (!d) throw new NotFoundException('Document not found');
    return d;
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const raw = await this.docs.raw(id);
    if (!raw) throw new NotFoundException('Document not found');
    res.setHeader('Content-Type', raw.mime + '; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${raw.filename}"`);
    res.send(raw.content);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: DocInput) {
    return this.docs.update(id, body || {});
  }

  @Post(':id/share')
  share(@Param('id') id: string, @Body() body: { shared?: boolean }) {
    return this.docs.setShared(id, !!body?.shared);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.docs.remove(id);
  }
}
