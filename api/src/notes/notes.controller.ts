import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { NotesService } from './notes.service';

@Controller('notes')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  async list(@Query('archived') archived?: string) {
    return this.notes.list(archived === '1' || archived === 'true');
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

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.notes.remove(id);
  }
}
