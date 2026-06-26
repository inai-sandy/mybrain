import { BadRequestException, Body, Controller, Delete, Get, Headers, NotFoundException, Param, Patch, Post, Put, Query, Res, UnauthorizedException, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import archiver from 'archiver';
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

  // ---- Bulk actions + export (BEA-539). Declared before ':id' routes. ----

  @Post('bulk/delete')
  bulkDelete(@Body() body: { ids?: string[] }) {
    return this.docs.bulkDelete(body?.ids || []);
  }

  @Post('bulk/tag')
  bulkTag(@Body() body: { ids?: string[]; tags?: string[] }) {
    return this.docs.bulkAddTags(body?.ids || [], body?.tags || []);
  }

  @Post('bulk/collection')
  bulkCollection(@Body() body: { ids?: string[]; collectionId?: string | null }) {
    return this.docs.bulkSetCollection(body?.ids || [], body?.collectionId ?? null);
  }

  @Post('bulk/share')
  bulkShare(@Body() body: { ids?: string[]; shared?: boolean }) {
    return this.docs.bulkSetShared(body?.ids || [], !!body?.shared);
  }

  /** Stream a zip of the chosen documents (or all when ids is empty). */
  @Post('export')
  async export(@Body() body: { ids?: string[] }, @Res() res: Response) {
    const rows = await this.docs.forExport(body?.ids);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="documents-${rows.length}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', () => res.end());
    archive.pipe(res);
    for (const r of rows) {
      const name = this.docs.exportName(r);
      if (r.filePath) archive.file(r.filePath, { name });
      else archive.append(r.contentText || '', { name });
    }
    await archive.finalize();
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

  // ---- Model picker (BEA-554). Declared before ':id'. ----
  @Get('model')
  getModel() {
    return this.docs.documentsModel();
  }
  @Put('model')
  setModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.docs.setDocumentsModel(body.provider || 'openrouter', body.model);
  }
  @Get('models')
  models() {
    return this.docs.documentsModels();
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

  /** Resolve a short share code to its slug, for the /s/:code route. Declared before ':id'. (BEA-584) */
  @Public()
  @Get('public/code/:code')
  async resolveCode(@Param('code') code: string) {
    const d = await this.docs.resolveShortCode(code);
    if (!d) throw new NotFoundException('This short link is not active.');
    return d;
  }

  /** Public read of a shared document by slug (no login). Must be declared before ':id'. */
  @Public()
  @Get('public/:slug')
  async public(@Param('slug') slug: string) {
    const d = await this.docs.getShared(slug);
    if (!d) throw new NotFoundException('This document is not shared (or no longer shared).');
    return d;
  }

  /** Verify a share password (or just fetch content for an expiry-only share). (BEA-585) */
  @Public()
  @Post('public/:slug/unlock')
  async unlock(@Param('slug') slug: string, @Body() body: { password?: string }) {
    return this.docs.unlockShared(slug, body?.password || '');
  }

  /** Public binary stream for a shared pdf/image doc. Honours expiry + password token. (BEA-553/585) */
  @Public()
  @Get('public/:slug/file')
  async publicFile(@Param('slug') slug: string, @Query('t') token: string, @Res() res: Response) {
    const f = await this.docs.sharedFile(slug, token);
    if (!f) throw new NotFoundException('Not shared.');
    res.setHeader('Content-Type', f.mime);
    res.setHeader('Content-Disposition', `inline; filename="${f.filename}"`);
    res.sendFile(f.filePath);
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

  /** Rename the public link (slug). (BEA-584) */
  @Post(':id/slug')
  async slug(@Param('id') id: string, @Body() body: { slug?: string }) {
    try {
      return await this.docs.setSlug(id, body?.slug || '');
    } catch (e: any) {
      throw new BadRequestException(e?.message || 'Could not rename the link.');
    }
  }

  /** Set/clear the share password and/or expiry. (BEA-585) */
  @Post(':id/protect')
  protect(@Param('id') id: string, @Body() body: { password?: string | null; expiresAt?: string | null }) {
    return this.docs.setProtection(id, { password: body?.password, expiresAt: body?.expiresAt });
  }

  /** Copy this document into Capture/memory (RAG + SuperMemory). (BEA-540) */
  @Post(':id/convert')
  async convert(@Param('id') id: string) {
    try {
      return await this.docs.convertToCapture(id);
    } catch (e: any) {
      throw new BadRequestException(e?.message || 'Could not add to memory.');
    }
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.docs.remove(id);
  }
}
