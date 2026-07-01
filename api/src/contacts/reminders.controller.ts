import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { RemindersService } from './reminders.service';

@Controller('reminders')
export class RemindersController {
  constructor(private readonly reminders: RemindersService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.reminders.list(status || undefined);
  }

  // ---- "Clean up" engine picker (Settings). Static routes — keep above any :id route. (BEA-731) ----
  @Get('format-model')
  getFormatModel() {
    return this.reminders.formatModel();
  }

  @Put('format-model')
  setFormatModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.reminders.setFormatModel(body.provider || 'openrouter', body.model);
  }

  @Get('format-models')
  async formatModels() {
    return { models: await this.reminders.listFormatModels() };
  }

  /** Open tasks with a person → suggested reminders (BEA-721). */
  @Get('suggestions')
  suggestions() {
    return this.reminders.suggestions();
  }

  /** Draft a reminder message in the user's voice. */
  @Post('draft')
  draft(@Body() body: { taskId?: string; taskTitle?: string; contactName?: string; userInput?: string }) {
    return this.reminders.draftMessage(body || {});
  }

  @Post()
  create(@Body() body: { contactId?: string; taskId?: string; message?: string; count?: number }) {
    return this.reminders.create(body || {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { message?: string; count?: number; status?: string }) {
    return this.reminders.update(id, body || {});
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.reminders.pause(id);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.reminders.resume(id);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.reminders.stop(id);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.reminders.remove(id);
  }
}
