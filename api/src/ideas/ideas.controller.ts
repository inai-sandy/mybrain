import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { IdeasService } from './ideas.service';

@Controller('ideas')
export class IdeasController {
  constructor(private readonly ideas: IdeasService) {}

  /** Capture a brain-dump → LLM formats into title + content + a /deep-research prompt. */
  @Post()
  async create(@Body() body: { dump?: string }) {
    const dump = (body?.dump || '').trim();
    if (!dump) throw new BadRequestException('Write something first');
    return this.ideas.create(dump);
  }

  @Get()
  async list() {
    return { ideas: await this.ideas.list() };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const d = await this.ideas.get(id);
    if (!d) throw new BadRequestException('Idea not found');
    return d;
  }

  @Post(':id/status')
  async status(@Param('id') id: string, @Body() body: { status?: string }) {
    const r = await this.ideas.setStatus(id, body?.status || 'done');
    if (!r) throw new BadRequestException('Idea not found');
    return r;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: { title?: string; content?: string }) {
    const r = await this.ideas.update(id, body || {});
    if (!r) throw new BadRequestException('Idea not found');
    return r;
  }
}
