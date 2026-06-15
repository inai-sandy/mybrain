import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { MeetingsService } from './meetings.service';
import { Public } from '../auth/public.decorator';

/** Public, unauthenticated read of a meeting the owner has shared (summary only — no transcript/audio). */
@Controller('meeting-share')
export class MeetingShareController {
  constructor(private readonly meetings: MeetingsService) {}

  @Public()
  @Get(':id')
  async get(@Param('id') id: string) {
    const d = await this.meetings.getShared(id);
    if (!d) throw new NotFoundException('This meeting is not shared (or no longer shared).');
    return d;
  }
}
