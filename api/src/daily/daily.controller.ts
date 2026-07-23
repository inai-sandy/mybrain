import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { DailyService } from './daily.service';
import { StoryMiningService, MinedPayload } from './story-mining.service';

@Controller('daily')
export class DailyController {
  constructor(
    private readonly daily: DailyService,
    private readonly mining: StoryMiningService, // LAST on purpose — keeps positional wiring stable (BEA-1051)
  ) {}

  /** The whole book in one call — chapters + pull-quotes + per-month mood + year arc. (BEA-1061) */
  @Get('book')
  book(@Query('year') year?: string) {
    return this.daily.bookData(year);
  }

  /** Insights that are about YOU — mood/energy over time, delegation & promise health, neglect. (BEA-1060) */
  @Get('insights')
  insights(@Query('days') days?: string) {
    return this.daily.insights(days ? Number(days) : 30);
  }

  /** The written "what's really going on" paragraph (cached daily). (BEA-1060) */
  @Get('insights/written')
  writtenInsight() {
    return this.daily.writtenInsight(false);
  }

  @Post('insights/written/regenerate')
  regenWrittenInsight() {
    return this.daily.writtenInsight(true);
  }

  /** One-time backfill of emotions + life-timeline for already-told days, so the card isn't empty. (BEA-1058) */
  @Post('backfill-feelings')
  backfillFeelings(@Body() body: { days?: number }) {
    return this.mining.backfillFeelings(body?.days ?? 7);
  }

  /** This morning's follow-up questions, written when the previous day closed. (BEA-1055) */
  @Get('morning-questions')
  morningQuestions() {
    return this.daily.morningQuestions();
  }

  /** Deep-mine a day's story: every proposal for the Close-day wizard. Creates NOTHING. (BEA-1051) */
  @Post('mine')
  async mine(@Body() body: { day?: string }) {
    if (!body?.day || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) throw new BadRequestException('Give the day as YYYY-MM-DD');
    return this.mining.mine(body.day);
  }

  /** Create exactly what the owner ticked from the mined proposals. (BEA-1051) */
  @Post('mine/apply')
  async mineApply(@Body() body: { day?: string; picked?: Partial<MinedPayload> }) {
    if (!body?.day || !/^\d{4}-\d{2}-\d{2}$/.test(body.day)) throw new BadRequestException('Give the day as YYYY-MM-DD');
    return this.mining.apply(body.day, body?.picked || {});
  }

  @Get('today')
  async today() {
    return this.daily.today();
  }

  /** Proactive-nudge preferences — "insights pull, not push" (BEA-527). */
  @Get('nudges')
  async getNudges() {
    return this.daily.getNudgePrefs();
  }

  @Put('nudges')
  async setNudges(@Body() body: { mentorPush?: boolean; storyReminder?: boolean }) {
    return this.daily.setNudgePrefs(body || {});
  }

  /** Activity screen for a given day (defaults to today). */
  @Get('activity')
  async activity(@Query('day') day?: string) {
    return this.daily.activity(day);
  }

  /** Aggregate insights (Dashboard). */
  @Get('dashboard')
  async dashboard(@Query('days') days?: string) {
    return this.daily.dashboard(days ? Number(days) : 30);
  }

  /** Per-day counts for the calendar heatmap. */
  @Get('calendar')
  async calendar(@Query('months') months?: string) {
    return this.daily.calendar(months ? Number(months) : 3);
  }

  /** Close (seal) a day — one act: finalize summary + story + mentor + suggestions, roll leftovers forward. */
  @Post('close')
  async close(@Body() body: { day?: string }) {
    const day = body?.day && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : (await this.daily.activity()).day;
    const r = await this.daily.closeDay(day, false, 'you closed it');
    if (!r) throw new BadRequestException('Could not close that day');
    return r;
  }

  /** Past days still open (for the "finish yesterday" prompt). */
  @Get('open-days')
  async openDays() {
    return this.daily.openDays();
  }

  /** Generate (or rebuild) the AI day-summary on demand. */
  @Post('summary')
  async summary(@Body() body: { day?: string; force?: boolean }) {
    const day = body?.day || undefined;
    return this.daily.generateSummary(day || (await this.daily.activity()).day, !!body?.force);
  }

  @Post('story')
  async story(@Body() body: { text?: string; source?: string; mood?: string; day?: string; noWrap?: boolean }) {
    if (!body?.text?.trim()) throw new BadRequestException('Tell your story first');
    // noWrap: the Close-day wizard saves the story itself and stays in charge of sealing (BEA-1052).
    return this.daily.submitStory(body.text, body.source || 'app', body.mood, body.day, body.noWrap === true);
  }

  /** One-shot: (re)index stories into the brain. ?all=1 re-indexes everything, else only un-indexed. (BEA-331) */
  @Post('reindex-stories')
  async reindexStories(@Query('all') all?: string) {
    return this.daily.backfillStories(all === '1' || all === 'true');
  }

  // ---- daily wrap-up: finished tasks found in the story + working hours + carry-forward ----
  @Post('done-candidates')
  async doneCandidates(@Body() body: { day?: string }) {
    return this.daily.doneCandidates(body?.day);
  }

  @Post('wrap-up-data')
  async wrapUpData(@Body() body: { day?: string }) {
    return this.daily.wrapUpData(body?.day);
  }

  @Post('wrap-up')
  async wrapUp(@Body() body: { day?: string; tasks?: { title?: string; category?: string | null }[]; workedMinutes?: number; roll?: string[]; drop?: string[] }) {
    return this.daily.wrapUp(body?.day, body?.tasks || [], body?.workedMinutes, body?.roll || [], body?.drop || []);
  }

  /** Add the to-dos spotted in the story as open tasks (today). (BEA-513) */
  @Post('add-todos')
  async addTodos(@Body() body: { todos?: { title?: string; category?: string | null; note?: string | null; priority?: string }[] }) {
    return this.daily.addStoryTodos(body?.todos || []);
  }

  // ---- Story of the Day (nightly woven narrative) ----
  @Post('day-story')
  async dayStory(@Body() body: { day?: string; force?: boolean }) {
    const day = body?.day || (await this.daily.activity()).day;
    return this.daily.generateDayStory(day, !!body?.force);
  }

  // ---- Story of the Month (chapters) ----
  @Get('months')
  async months() {
    return this.daily.listMonths();
  }

  @Post('month-story')
  async monthStory(@Body() body: { month?: string; force?: boolean }) {
    if (!body?.month || !/^\d{4}-\d{2}$/.test(body.month)) throw new BadRequestException('Pick a month');
    const r = await this.daily.generateMonthStory(body.month, !!body?.force);
    return r || { ok: false, message: 'That month needs at least 3 recorded days before it can become a chapter.' };
  }

  /** People memory: who appears in your stories. */
  @Get('people')
  async people() {
    return this.daily.peopleOverview();
  }

  /** One person's full history — every recorded point involving them. */
  @Get('people/detail')
  async personDetail(@Query('name') name?: string) {
    const r = await this.daily.personDetail(name || '');
    if (!r) throw new BadRequestException('Person not found');
    return r;
  }

  /** Merge a duplicate person into the canonical one (drag-and-drop on the People card). */
  @Post('people/merge')
  async mergePeople(@Body() body: { from?: string; into?: string }) {
    const r = await this.daily.mergePeople(body?.from || '', body?.into || '');
    if (!r) throw new BadRequestException('Pick two different people to merge');
    return r;
  }

  // ---- Story of the Year ----
  @Get('year-story')
  async yearStory(@Query('year') year?: string) {
    const y = year && /^\d{4}$/.test(year) ? year : String(new Date().getFullYear());
    return (await this.daily.getYearStory(y)) || { year: y, missing: true };
  }

  @Post('year-story')
  async writeYearStory(@Body() body: { year?: string; force?: boolean }) {
    const y = body?.year && /^\d{4}$/.test(body.year) ? body.year : String(new Date().getFullYear());
    const r = await this.daily.generateYearStory(y, !!body?.force);
    return r || { ok: false, message: 'No monthly chapters exist for that year yet — write a chapter first.' };
  }

  // ---- per-feature model pickers ----
  @Get('book-model')
  async getBookModel() {
    return this.daily.bookModel();
  }

  @Put('book-model')
  async setBookModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.daily.setBookModel(body.provider || 'openrouter', body.model);
  }

  @Get('book-models')
  async bookModels() {
    return { models: await this.daily.listModels() };
  }

  @Get('people-model')
  async getPeopleModel() {
    return this.daily.peopleModel();
  }

  @Put('people-model')
  async setPeopleModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.daily.setPeopleModel(body.provider || 'openrouter', body.model);
  }

  @Get('people-models')
  async peopleModels() {
    return { models: await this.daily.listModels() };
  }

  @Get('story-model')
  async getStoryModel() {
    // Raw {provider, model}; the Settings card derives the picker id (agents use composite ids) uniformly.
    return this.daily.storyModel();
  }

  @Put('story-model')
  async setStoryModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.daily.setStoryModel(body.provider || 'openrouter', body.model);
  }

  @Get('story-models')
  async storyModels() {
    return { models: await this.daily.listModels() };
  }

  @Get('summary-model')
  async getSummaryModel() {
    return this.daily.summaryModel();
  }

  @Put('summary-model')
  async setSummaryModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.daily.setSummaryModel(body.provider || 'openrouter', body.model);
  }

  @Get('summary-models')
  async summaryModels() {
    return { models: await this.daily.listModels() };
  }

  /** Home "Today" card — focus + top suggested action + key lever. (BEA-518)
   *  Distinct path so it isn't shadowed by @Get('today') above (which returns story/notes). (BEA-936) */
  @Get('today-card')
  async todayCard() {
    return this.daily.todayCard();
  }

  // ---- predictive (suggested) tasks for tomorrow ----
  @Get('suggestions')
  async suggestions(@Query('day') day?: string) {
    return this.daily.listSuggestions(day);
  }

  @Post('suggestions/generate')
  async genSuggestions(@Body() body: { day?: string }) {
    const day = body?.day || (await this.daily.activity()).day;
    return { suggestions: await this.daily.generateSuggestions(day) };
  }

  @Post('suggestions/:id/add')
  async addSuggestion(@Param('id') id: string) {
    const r = await this.daily.addSuggestion(id);
    if (!r) throw new BadRequestException('Suggestion not found or already handled');
    return r;
  }

  @Post('suggestions/:id/dismiss')
  async dismissSuggestion(@Param('id') id: string) {
    return this.daily.dismissSuggestion(id);
  }

  // ---- agentic personality engine + Validate ----
  @Get('personality')
  async personality() {
    return this.daily.getPersonality();
  }

  @Post('personality/regenerate')
  async regeneratePersonality() {
    return this.daily.regeneratePersonality();
  }

  @Post('personality/insight/:id')
  async validateInsight(@Param('id') id: string, @Body() body: { status?: string }) {
    const r = await this.daily.validateInsight(id, body?.status || 'pending');
    if (!r) throw new BadRequestException('Insight not found');
    return r;
  }

  @Post('note')
  async note(@Body() body: { text?: string; source?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Add a note');
    return this.daily.addNote(body.text, body.source || 'app');
  }

  @Delete('note/:id')
  async removeNote(@Param('id') id: string) {
    return this.daily.deleteNote(id);
  }
}
