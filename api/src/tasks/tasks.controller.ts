import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { ClaimsService } from './claims.service';
import { TaskHealthService } from './task-health.service';
import { RecurringService } from './recurring.service';
import { DelegationService } from './delegation.service';

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly claims: ClaimsService,
    private readonly health: TaskHealthService,
    private readonly recurring: RecurringService,
    private readonly delegation: DelegationService,
  ) {}

  /** Morning brain-dump -> tasks. */
  @Post('dump')
  async dump(@Body() body: { text?: string; source?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Dump some text first');
    return this.tasks.dump(body.text, body.source || 'app');
  }

  /** One-shot: (re)index tasks into the brain. ?all=1 re-indexes everything, else only un-indexed. (BEA-331) */
  @Post('reindex')
  async reindex(@Query('all') all?: string) {
    return this.tasks.backfillIndex({ all: all === '1' || all === 'true' });
  }

  /** Remove every open-task entry from memory (deletion only — no AI). (BEA-546) */
  @Post('purge-open-memory')
  async purgeOpenMemory() {
    return this.tasks.purgeOpenTaskMemory();
  }

  /** Deep sweep: delete orphan task docs left in the stores (deletion only). (BEA-548) */
  @Post('purge-orphan-task-docs')
  async purgeOrphanTaskDocs() {
    return this.tasks.purgeOrphanTaskDocs();
  }

  /** Wipe all task docs from memory and re-index only the done tasks (clears all dups). (BEA-549) */
  @Post('rebuild-task-memory')
  async rebuildTaskMemory() {
    return this.tasks.rebuildTaskMemory();
  }

  /** Stop indexing low-value sources (Vault, day summaries, portrait) + purge them. (BEA-551) */
  @Post('purge-low-value-memory')
  async purgeLowValueMemory() {
    return this.tasks.purgeLowValueSources();
  }

  @Get('today')
  async today() {
    return this.tasks.today();
  }

  /** Every task involving a given person (across all days/statuses). */
  /** Everything someone says is finished, waiting on your decision. (BEA-1024) */
  @Get('claims')
  async listClaims() {
    return { claims: await this.claims.pending() };
  }

  /** Days no daily report is owed — no chasing, and no "missed" recorded. (BEA-1117) */
  /** Every rule that governs the chase, for the Tasks settings screen. (BEA-1161) */
  @Get('settings')
  taskSettings() {
    return this.recurring.taskSettings();
  }

  @Put('settings')
  setTaskSettings(@Body() body: { chaseTimes?: unknown; claimGraceDays?: unknown; restDays?: unknown; digestHour?: unknown }) {
    return this.recurring.setTaskSettings(body || {});
  }

  @Get('recurring/rest-days')
  async getRestDays() {
    return { days: await this.recurring.restDays() };
  }

  @Put('recurring/rest-days')
  async setRestDays(@Body() body: { days?: unknown }) {
    return this.recurring.setRestDays(body?.days);
  }

  /**
   * A day's standing reports: who owed what, and whether it came in. This is what the owner reads
   * instead of a review queue — a daily report is never confirmed, only received or missed. (BEA-1120)
   */
  /** Set which weekdays a standing report is owed on. (BEA-1147) */
  @Put('recurring/:id/schedule')
  async setSchedule(@Param('id') id: string, @Body() body: { days?: unknown }) {
    return this.recurring.setSchedule(id, body?.days);
  }

  /** One-time: read the days out of each existing report's own title. Reports back for correction. */
  @Post('recurring/seed-schedules')
  async seedSchedules() {
    return this.recurring.seedSchedulesFromTitles();
  }

  @Get('recurring/day-log')
  async dayLog(@Query('day') day?: string) {
    return this.recurring.dayLog(day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined);
  }

  /** Confirm or reject one claim. Confirming is the ONLY way a claim becomes a completion. */
  @Post('claims/:id/decide')
  async decideClaim(@Param('id') id: string, @Body() body: { confirm?: boolean; reason?: string }) {
    return this.delegation.decideClaim(id, body?.confirm !== false, body?.reason);
  }

  /** Confirm several obviously-fine claims at once. (BEA-1025) */
  @Post('claims/decide-many')
  async decideMany(@Body() body: { ids?: string[]; confirm?: boolean }) {
    const ids = (body?.ids || []).filter((x) => typeof x === 'string').slice(0, 100);
    return this.delegation.decideManyClaims(ids, body?.confirm !== false);
  }

  /**
   * The work ended without being finished. (BEA-1306)
   *
   * Separate from done on purpose — dropped work must never be counted as an achievement, and the
   * person must never be thanked for completing it.
   */
  @Post(':id/drop')
  async drop(@Param('id') id: string, @Body() body: { reason?: string }) {
    const r = await this.tasks.setDropped(id, body?.reason);
    if (!r) throw new BadRequestException('That task no longer exists.');
    return r;
  }

  /**
   * Hand this work to somebody else. (BEA-1308)
   *
   * The old chase stops and the new person's starts. Before this, a job belonged to whoever it
   * started with for ever — reassigning moved it on screen while the old person kept getting the
   * WhatsApp messages.
   */
  @Post(':id/hand-over')
  handOver(@Param('id') id: string, @Body() body: { toContactId?: string; reason?: string }) {
    if (!body?.toContactId) throw new BadRequestException('Who is taking it on?');
    return this.delegation.handOver(id, body.toContactId, body.reason);
  }

  /** Undo the last handover — give it straight back. (BEA-1308) */
  @Post(':id/hand-back')
  handBack(@Param('id') id: string) {
    return this.delegation.undoHandOver(id);
  }

  /** What the `@names` in some text resolve to — so the form can show it as you type. (BEA-1019) */
  @Post('mentions/resolve')
  async resolveMentions(@Body() body: { text?: string }) {
    return { mentions: await this.tasks.resolveMentionText(String(body?.text || '')) };
  }

  /** Person names on old tasks that could NOT be linked to one contact — for the owner to fix. (BEA-1019) */
  @Get('people/unlinked')
  async unlinkedParties() {
    return { unmatched: await this.tasks.unlinkedParties() };
  }

  /** Everything you've given other people. (BEA-1029) */
  @Get('delegated')
  delegated(@Query('contactId') contactId?: string) {
    return this.tasks.delegated(contactId || undefined);
  }

  /** Who's stalling right now. (BEA-1030) */
  @Get('stalling')
  stalling() {
    return this.tasks.stalling();
  }

  @Get('by-person')
  async byPerson(@Query('name') name?: string) {
    return { tasks: await this.tasks.byPerson(name || '') };
  }

  @Get()
  async list(@Query('day') day?: string) {
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) return { tasks: await this.tasks.forDay(day) };
    return { tasks: await this.tasks.list() };
  }

  // ---- model picker (OpenAI + Anthropic only) ----
  @Get('model')
  async getModel() {
    return this.tasks.getModel();
  }

  @Put('model')
  async setModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.tasks.setModel(body.provider || 'openrouter', body.model);
  }

  @Get('models')
  async models() {
    return { models: await this.tasks.listModels() };
  }

  // ---- Brain Eaters (BEA-1056). Declared before ':id' routes. ----
  @Get('brain-eaters')
  brainEaters() {
    return this.tasks.brainEaters();
  }

  @Post('brain-eaters/dump')
  dumpBrainEaters(@Body() body: { text?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Dump what is circling your head first');
    return this.tasks.dumpBrainEaters(body.text);
  }

  @Post('brain-eaters/mark')
  markBrainEaters(@Body() body: { ids?: string[]; on?: boolean }) {
    if (!body?.ids?.length) throw new BadRequestException('Nothing selected');
    return this.tasks.markBrainEater(body.ids, body?.on !== false);
  }

  /** Run the health check now — the same one that runs nightly. Reports, never changes anything. */
  @Get('health')
  async healthCheck() {
    return { findings: await this.health.check() };
  }

  // ---- AI duplicate cleanup ----
  /** Analyze open tasks and return duplicate groups for review (nothing is deleted here). */
  @Post('find-duplicates')
  async findDuplicates() {
    return this.tasks.findDuplicates();
  }

  /** Delete the user-confirmed duplicate ids (open tasks only). */
  @Post('remove-duplicates')
  async removeDuplicates(@Body() body: { ids?: string[] }) {
    return this.tasks.removeDuplicates(body?.ids || []);
  }

  /** MERGE the user-confirmed duplicate groups onto their keepers — nothing of value is lost. (BEA-1057) */
  @Post('merge-duplicates')
  async mergeDuplicates(@Body() body: { groups?: { keepId?: string; removeIds?: string[] }[] }) {
    return this.tasks.mergeDuplicates(body?.groups || []);
  }

  @Post()
  async create(@Body() body: any) {
    if (!body?.title?.trim()) throw new BadRequestException('Add a title');
    const t = await this.tasks.create(body || {});
    if (!t) throw new BadRequestException('Could not create task');
    return t;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    const t = await this.tasks.update(id, body || {});
    if (!t) throw new BadRequestException('Task not found');
    return t;
  }

  @Post(':id/done')
  async done(@Param('id') id: string, @Body() body: { done?: boolean; actualMin?: number; followUpDate?: string }) {
    const t = await this.tasks.setDone(id, body?.done ?? true, body?.actualMin, body?.followUpDate);
    if (!t) throw new BadRequestException('Task not found');
    return t;
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.tasks.remove(id);
  }
}
