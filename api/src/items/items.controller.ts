import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ItemsService } from './items.service';
import { NotionService } from './notion.service';

@Controller('items')
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly notion: NotionService,
  ) {}

  private parseTags(input: unknown): string[] {
    if (Array.isArray(input)) return input.map((t) => String(t));
    return String(input || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: any, @Body() body: { tags?: string }) {
    if (!file?.buffer) throw new BadRequestException('No file provided');
    const content = file.buffer.toString('utf8');
    if (!content.trim()) throw new BadRequestException('That file is empty');
    const title = String(file.originalname || '').replace(/\.(md|markdown|txt)$/i, '');
    return this.items.store(content, 'upload', title, undefined, this.parseTags(body?.tags));
  }

  @Post('url')
  async fromUrl(@Body() body: { url?: string; tags?: string }) {
    const url = (body?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new BadRequestException('Provide a valid http(s) URL');
    let content: string;
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      content = await r.text();
    } catch {
      throw new BadRequestException('Could not fetch that URL');
    }
    if (!content.trim()) throw new BadRequestException('That URL returned no content');
    return this.items.store(content, 'url', url.split('/').filter(Boolean).pop() || url, url, this.parseTags(body?.tags));
  }

  @Post('notion')
  async fromNotion(@Body() body: { url?: string; tags?: string }) {
    const { title, markdown } = await this.notion.fetchMarkdown(body?.url || '');
    return this.items.store(markdown, 'notion', title, body?.url, this.parseTags(body?.tags));
  }

  @Post('import-supermemory')
  async importSuperMemory() {
    return this.items.importFromSuperMemory();
  }

  @Get()
  async list() {
    return { items: await this.items.list() };
  }

  @Get(':id/content')
  async content(@Param('id') id: string) {
    const doc = await this.items.getContent(id);
    if (!doc) throw new BadRequestException('Document not found');
    return doc;
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const doc = await this.items.getDetail(id);
    if (!doc) throw new BadRequestException('Document not found');
    return doc;
  }

  @Post(':id/sync')
  async sync(@Param('id') id: string) {
    const res = await this.items.sync(id);
    if (!res) throw new BadRequestException('Document not found');
    if (!res.ok) throw new BadRequestException(res.reason || 'Sync failed');
    return res;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.items.remove(id);
    return { ok: true };
  }
}
