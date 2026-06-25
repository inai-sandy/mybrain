import { Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

  /** Upload a file (md/html/pdf/image) into the library. (BEA-534) */
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: any) {
    if (!file) throw new NotFoundException('No file uploaded');
    return this.docs.createFromUpload(file);
  }

  /** Stream a stored binary file (pdf/image) inline — used by the viewer preview and binary download. */
  @Get(':id/file')
  async file(@Param('id') id: string, @Res() res: Response) {
    const f = await this.docs.file(id);
    if (!f) throw new NotFoundException('File not found');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`);
    res.sendFile(f.filePath);
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
    const f = await this.docs.file(id);
    if (f) {
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Content-Disposition', `attachment; filename="${f.filename}"`);
      res.sendFile(f.filePath);
      return;
    }
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
