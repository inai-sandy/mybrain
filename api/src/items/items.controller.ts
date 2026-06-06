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

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: any) {
    if (!file?.buffer) throw new BadRequestException('No file provided');
    const content = file.buffer.toString('utf8');
    if (!content.trim()) throw new BadRequestException('That file is empty');
    const title = String(file.originalname || '').replace(/\.(md|markdown|txt)$/i, '');
    return this.items.store(content, 'upload', title);
  }

  @Post('url')
  async fromUrl(@Body() body: { url?: string }) {
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
    return this.items.store(content, 'url', url.split('/').filter(Boolean).pop() || url);
  }

  @Post('notion')
  async fromNotion(@Body() body: { url?: string }) {
    const { title, markdown } = await this.notion.fetchMarkdown(body?.url || '');
    return this.items.store(markdown, 'notion', title);
  }

  @Get()
  async list() {
    return { items: await this.items.list() };
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.items.remove(id);
    return { ok: true };
  }
}
