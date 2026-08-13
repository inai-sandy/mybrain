import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { RemindersService } from './reminders.service';
import { TeamUpdatesService } from './team-updates.service';
import { ClaimsService } from '../tasks/claims.service';
import { TasksService } from '../tasks/tasks.service';
import { DelegationService } from '../tasks/delegation.service';

@Controller('reminders')
export class RemindersController {
  constructor(
    private readonly reminders: RemindersService,
    private readonly updates: TeamUpdatesService,
    private readonly claims: ClaimsService,
    private readonly tasks: TasksService,
    private readonly delegation: DelegationService,
  ) {}

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

  /** Send a manual message to the contact from the chat window (BEA-736). The contact thread
   *  (Message button, id 'thread') carries the contactId as its anchor. (BEA-1226) */
  @Post(':id/message')
  sendMessage(@Param('id') id: string, @Body() body: { body?: string; contactId?: string }) {
    return this.reminders.sendManual(id, body?.body || '', body?.contactId || undefined);
  }

  /** Re-send the approved template to re-open the 24h chat window. (BEA-917/1226) */
  @Post(':id/resend-template')
  resendTemplate(@Param('id') id: string, @Body() body?: { contactId?: string }) {
    return this.reminders.resendTemplate(id, body?.contactId || undefined);
  }

  /** One-time: bring in everything already said, so the inbox is not empty on day one. (BEA-1159) */
  @Post('review/backfill')
  reviewBackfill() {
    return this.updates.backfill();
  }

  /** Everything the team said that needs him — the review inbox. (BEA-1159) */
  @Get('review')
  review() {
    return this.updates.inbox();
  }

  /** He answers from inside review; it goes out on WhatsApp and lands in their thread. */
  @Post('review/:id/reply')
  reviewReply(@Param('id') id: string, @Body() body: { text?: string }) {
    return this.updates.reply(id, String(body?.text || ''));
  }

  /**
   * Yes it's done / no it isn't. A "no" puts the chase straight back on. (BEA-1159)
   *
   * The decision runs through the existing claims path so the task and the chase move together —
   * confirming marks it done and stops the chase, rejecting reopens it and the chase resumes.
   */
  @Post('review/:id/decide')
  async reviewDecide(@Param('id') id: string, @Body() body: { confirm?: boolean; claimId?: string }) {
    const confirm = body?.confirm !== false;
    return this.updates.decide(
      id,
      confirm,
      // Both callbacks go through the ONE door, so this screen can never drift from the others.
      async (claimId, ok) => this.delegation.decideClaim(claimId, ok),
      // They said "all done" but only one claim was ever raised — a yes on the others marks them
      // done directly, which is the same end state and stops their chase the same way. (BEA-1159)
      async (taskId, done) => this.delegation.finishTask(taskId, done),
      // The exact claim the screen showed — a host item carries an attached claim id, and
      // re-guessing it server-side breaks when the contact holds two. (BEA-1221)
      body?.claimId || undefined,
    );
  }

  /** Only he closes it — the problem is solved. */
  @Post('review/:id/close')
  reviewClose(@Param('id') id: string) {
    return this.updates.close(id);
  }

  @Post('review/:id/reopen')
  reviewReopen(@Param('id') id: string) {
    return this.updates.reopen(id);
  }

  /** One person's whole story — both channels, in time order. (BEA-1159) */
  @Get('review/contact/:id')
  reviewForContact(@Param('id') id: string) {
    return this.updates.forContact(id);
  }

  /** Chases with no work behind them — nobody can finish these. Static route, before :id. (BEA-1292) */
  @Get('loose')
  loose() {
    return this.reminders.loose();
  }

  /** Give one loose chase something to point at, or stop it. (BEA-1292) */
  @Post(':id/link-task')
  linkLoose(@Param('id') id: string, @Body() body: { mode?: string; taskId?: string; title?: string }) {
    return this.reminders.linkLoose(id, body || {});
  }

  /** Chases the app switched off by itself, for the owner to resume. (BEA-1160) */
  @Get('auto-stopped')
  autoStopped() {
    return this.reminders.autoStopped();
  }

  @Post(':id/resume-auto-stopped')
  resumeAutoStopped(@Param('id') id: string) {
    return this.reminders.resumeAutoStopped(id);
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
