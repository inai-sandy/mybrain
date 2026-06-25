import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { TasksService } from './tasks.service';

@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

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
