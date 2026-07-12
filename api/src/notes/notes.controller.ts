import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { NotesService } from './notes.service';

@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  async list(@Query('archived') archived?: string) {
    return this.notes.list(archived === '1' || archived === 'true');
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const n = await this.notes.get(id);
    if (!n) throw new BadRequestException('Note not found');
    return n;
  }

  @Post()
  async create(@Body() body: any) {
    const n = await this.notes.create(body || {});
    if (!n) throw new BadRequestException('Add a title, some text, or a checklist item');
    return n;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    const n = await this.notes.update(id, body || {});
    if (!n) throw new BadRequestException('Note not found');
    return n;
  }

  /** AI clean-up + Markdown formatting for a note (BEA-964). Returns previous content for Undo. */
  @Post(':id/format')
  async format(@Param('id') id: string) {
    const r = await this.notes.aiFormat(id);
    if (!r.ok) throw new BadRequestException('Nothing to format yet — add some text first.');
    return r;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.notes.remove(id);
  }
}
