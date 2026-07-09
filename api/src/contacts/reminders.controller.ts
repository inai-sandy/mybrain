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

  /** WhatsApp-style conversation list — newest reply on top (BEA-921). */
  @Get('conversations')
  conversations() {
    return this.reminders.conversations();
  }

  // Clear suggested reminders so they stop piling up (BEA-882).
  @Post('suggestions/dismiss')
  dismissSuggestion(@Body() body: { taskId?: string }) {
    return this.reminders.dismissSuggestion(body?.taskId || '');
  }

  @Post('suggestions/dismiss-all')
  dismissAllSuggestions() {
    return this.reminders.dismissAllSuggestions();
  }

  /** AI-backfill the person on old open tasks so they surface as suggestions (BEA-738). */
  @Post('scan-tasks')
  scanTasks() {
    return this.reminders.scanTasksForPeople();
  }

  /** Draft a reminder message in the user's voice. */
  @Post('draft')
  draft(@Body() body: { taskId?: string; taskTitle?: string; contactName?: string; userInput?: string }) {
    return this.reminders.draftMessage(body || {});
  }

  @Post()
  create(@Body() body: { contactId?: string; taskId?: string; subject?: string; message?: string; notes?: string; count?: number; times?: string[]; startDay?: string }) {
    return this.reminders.create(body || {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { subject?: string; message?: string; notes?: string; count?: number; status?: string; times?: string[]; startDay?: string }) {
    return this.reminders.update(id, body || {});
  }

  /** A contact's shared conversation + all their reminder items (BEA-742). Static route — before :id. */
  @Get('contact/:contactId/thread')
  contactThread(@Param('contactId') contactId: string) {
    return this.reminders.contactThread(contactId);
  }

  /** Mark a contact's chat as read — clears its unread badge (BEA-922). */
  @Post('contact/:contactId/read')
  markRead(@Param('contactId') contactId: string) {
    return this.reminders.markRead(contactId);
  }

  /** The reminder's WhatsApp conversation + captured outcome (BEA-730). */
  @Get(':id/thread')
  thread(@Param('id') id: string) {
    return this.reminders.thread(id);
  }

  /** Send a manual message to the contact from the chat window (BEA-736). */
  @Post(':id/message')
  sendMessage(@Param('id') id: string, @Body() body: { body?: string }) {
    return this.reminders.sendManual(id, body?.body || '');
  }

  /** Re-send the approved template to re-open the 24h chat window. (BEA-917) */
  @Post(':id/resend-template')
  resendTemplate(@Param('id') id: string) {
    return this.reminders.resendTemplate(id);
  }

  @Post('resume-today')
  resumeToday() {
    return this.reminders.resumeToday();
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
