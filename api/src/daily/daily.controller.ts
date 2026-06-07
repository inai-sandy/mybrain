import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
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
