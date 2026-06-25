import { BadRequestException, Body, Controller, Delete, Get, Headers, NotFoundException, Param, Patch, Post, Query, Res, UnauthorizedException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { DocumentsService, DocInput } from './documents.service';
import { Public } from '../auth/public.decorator';

const PUBLIC_BASE = process.env.PUBLIC_URL || 'https://mybrain.1site.ai';

@Controller('documents')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Get()
  list() {
    return this.docs.list();
  }

  /** Full-text-ish search across title, description, tags and content. (BEA-538) */
  @Get('search')
  search(@Query('q') q?: string) {
    return this.docs.search(q || '');
  }

  @Post()
  create(@Body() body: DocInput) {
    return this.docs.create(body || {});
  }

  /** Import a document from a URL (fetch + store + summarize). (BEA-536) */
  @Post('import-url')
  async importUrl(@Body() body: { url?: string }) {
    if (!body?.url?.trim()) throw new BadRequestException('Give me a link to import.');
    try {
      return await this.docs.importFromUrl(body.url.trim());
    } catch (e: any) {
      throw new BadRequestException(e?.message || 'Could not import that link.');
    }
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

  // ---- Server-to-server ingest (BEA-535). Declared before ':id' routes. ----

  /** The token + endpoint for the Settings card. */
  @Get('ingest-token')
  async getIngestToken() {
    return { token: await this.docs.ingestToken(), url: `${PUBLIC_BASE}/api/documents/ingest` };
  }

  @Post('ingest-token/regenerate')
  async regenerateIngestToken() {
    return { token: await this.docs.regenerateIngestToken(), url: `${PUBLIC_BASE}/api/documents/ingest` };
  }

  /** Token-protected entry point another server posts to (a file, or JSON). */
  @Public()
  @Post('ingest')
  @UseInterceptors(FileInterceptor('file'))
  async ingest(
    @UploadedFile() file: any,
    @Body() body: { title?: string; contentText?: string; kind?: string; tags?: string[] | string; sourceUrl?: string; originServer?: string },
    @Headers('x-ingest-token') headerToken: string,
    @Headers('authorization') auth: string,
  ) {
    const token = headerToken || (auth?.toLowerCase().startsWith('bearer ') ? auth.slice(7) : '');
    if (!(await this.docs.verifyIngestToken(token))) throw new UnauthorizedException('Invalid or missing ingest token');
    const tags = Array.isArray(body?.tags) ? body.tags : typeof body?.tags === 'string' ? body.tags.split(',').map((t) => t.trim()).filter(Boolean) : undefined;
    if (!file && !body?.contentText) throw new NotFoundException('Provide a file or contentText');
    return this.docs.ingest({ file, title: body?.title, contentText: body?.contentText, kind: body?.kind, tags, sourceUrl: body?.sourceUrl, originServer: body?.originServer });
  }

  // ---- Collections (BEA-537). Declared before ':id' routes. ----

  @Get('collections')
  listCollections() {
    return this.docs.listCollections();
  }

  @Post('collections')
  createCollection(@Body() body: { name?: string; color?: string }) {
    return this.docs.createCollection(body?.name || '', body?.color);
  }

  @Patch('collections/:id')
  renameCollection(@Param('id') id: string, @Body() body: { name?: string; color?: string }) {
    return this.docs.renameCollection(id, body?.name || '', body?.color);
  }

  @Delete('collections/:id')
  removeCollection(@Param('id') id: string) {
    return this.docs.removeCollection(id);
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
