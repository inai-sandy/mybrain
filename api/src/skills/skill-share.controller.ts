import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SkillsService } from './skills.service';
import { Public } from '../auth/public.decorator';

/** Public, unauthenticated read + download of a skill the owner has shared. */
@Controller('skill-share')
export class SkillShareController {
  constructor(private readonly skills: SkillsService) {}

  @Public()
  @Get(':id')
  async get(@Param('id') id: string) {
    const d = await this.skills.getShared(id);
    if (!d) throw new NotFoundException('This skill is not shared (or no longer shared).');
    return d;
  }

  @Public()
  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const f = await this.skills.fileFor(id, true);
    if (!f) throw new NotFoundException('Not available');
    res.download(f.filePath, f.name);
  }
}
