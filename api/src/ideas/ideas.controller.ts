import { BadRequestException, Body, Controller, Get, Param, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

  /** The saved agentic workflow (node stack) for this idea. */
  @Get(':id/workflow')
  async getWorkflow(@Param('id') id: string) {
    return this.ideas.getWorkflow(id);
  }

  @Put(':id/workflow')
  async saveWorkflow(@Param('id') id: string, @Body() body: { name?: string; nodes?: any[] }) {
    const r = await this.ideas.saveWorkflow(id, body || {});
    if (!r) throw new BadRequestException('Idea not found');
    return r;
  }

  /** Upload a research .md → becomes a Capture doc linked to this idea. */
  @Post(':id/upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@Param('id') id: string, @UploadedFile() file: any) {
    if (!file?.buffer) throw new BadRequestException('No file provided');
    const content = file.buffer.toString('utf8');
    if (!content.trim()) throw new BadRequestException('That file is empty');
    const title = String(file.originalname || '').replace(/\.(md|markdown|txt)$/i, '');
    const r = await this.ideas.addDoc(id, content, title);
    if (!r) throw new BadRequestException('Idea not found');
    return r;
  }
}
