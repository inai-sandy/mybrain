import { BadRequestException, Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
import { MentorService } from './mentor.service';

@Controller('mentor')
export class MentorController {
  constructor(private readonly mentor: MentorService) {}

  /** Focus areas, latest guidance, and the trend series for the graph. */
  @Get('overview')
  async overview(@Query('days') days?: string) {
    return this.mentor.overview(days ? Number(days) : 30);
  }

  // ---- focus areas ----
  @Get('focus')
  async focus() {
    return this.mentor.listFocusAreas();
  }

  @Post('focus')
  async createFocus(@Body() body: { title?: string; description?: string }) {
    const f = await this.mentor.createFocusArea(body?.title || '', body?.description);
    if (!f) throw new BadRequestException('Add a title');
    return f;
  }

  @Put('focus/:id')
  async updateFocus(@Param('id') id: string, @Body() body: { title?: string; description?: string; status?: string }) {
    const f = await this.mentor.updateFocusArea(id, body || {});
    if (!f) throw new BadRequestException('Focus area not found');
    return f;
  }

  @Post('focus/derive')
  async derive() {
    return { proposed: await this.mentor.deriveFocusAreas() };
  }

  // ---- daily read ----
  @Post('run')
  async run(@Body() body: { day?: string; force?: boolean }) {
    const r = await this.mentor.runMentorDay(body?.day || (await this.mentor.overview()).latest?.day || todayKey(), !!body?.force);
    return r || { ok: false, message: 'Nothing to mentor on yet — tell your story or finish a task first.' };
  }

  // ---- model picker ----
  @Get('model')
  async getModel() {
    return this.mentor.mentorModel();
  }

  @Put('model')
  async setModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.mentor.setMentorModel(body.provider || 'openrouter', body.model);
  }

  @Get('models')
  async models() {
    return { models: await this.mentor.listModels() };
  }
}

function todayKey(): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
