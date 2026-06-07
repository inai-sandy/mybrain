import { BadRequestException, Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { DailyService } from './daily.service';

@Controller('daily')
export class DailyController {
  constructor(private readonly daily: DailyService) {}

  @Get('today')
  async today() {
    return this.daily.today();
  }

  @Post('story')
  async story(@Body() body: { text?: string; source?: string; mood?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Tell your story first');
    return this.daily.submitStory(body.text, body.source || 'app', body.mood);
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
