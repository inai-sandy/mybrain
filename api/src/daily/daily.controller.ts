import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Put, Query } from '@nestjs/common';
import { DailyService } from './daily.service';

@Controller('daily')
export class DailyController {
  constructor(private readonly daily: DailyService) {}

  @Get('today')
  async today() {
    return this.daily.today();
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

  /** Generate (or rebuild) the AI day-summary on demand. */
  @Post('summary')
  async summary(@Body() body: { day?: string; force?: boolean }) {
    const day = body?.day || undefined;
    return this.daily.generateSummary(day || (await this.daily.activity()).day, !!body?.force);
  }

  @Post('story')
  async story(@Body() body: { text?: string; source?: string; mood?: string; day?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Tell your story first');
    return this.daily.submitStory(body.text, body.source || 'app', body.mood, body.day);
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

  @Get('story-model')
  async getStoryModel() {
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
