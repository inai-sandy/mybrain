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
  async story(@Body() body: { text?: string; source?: string; mood?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Tell your story first');
    return this.daily.submitStory(body.text, body.source || 'app', body.mood);
  }

  // ---- Story of the Day (nightly woven narrative) ----
  @Post('day-story')
  async dayStory(@Body() body: { day?: string; force?: boolean }) {
    const day = body?.day || (await this.daily.activity()).day;
    return this.daily.generateDayStory(day, !!body?.force);
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
