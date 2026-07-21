import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { BriefingsService, DraftTask } from './briefings.service';

/** Briefings live under the person they are about. (BEA-1020) */
@Controller()
export class BriefingsController {
  constructor(private readonly briefings: BriefingsService) {}

  /** Propose the tasks in a briefing. Saves nothing — the owner reviews first. */
  @Post('contacts/:id/briefings/draft')
  draft(@Param('id') id: string, @Body() body: { text?: string }) {
    return this.briefings.draft(id, String(body?.text || ''));
  }

  /** Save the briefing plus exactly the tasks the owner kept. */
  @Post('contacts/:id/briefings')
  create(@Param('id') id: string, @Body() body: { text?: string; summary?: string; tasks?: DraftTask[]; chase?: { times?: string[] } | null }) {
    return this.briefings.create(id, body || {});
  }

  @Get('contacts/:id/briefings')
  list(@Param('id') id: string) {
    return this.briefings.list(id);
  }

  @Patch('briefings/:id')
  update(@Param('id') id: string, @Body() body: { rawText?: string; summary?: string }) {
    return this.briefings.update(id, body || {});
  }

  /** Delete the note. The tasks it created stay — they are real work. */
  @Delete('briefings/:id')
  remove(@Param('id') id: string) {
    return this.briefings.remove(id);
  }
}
