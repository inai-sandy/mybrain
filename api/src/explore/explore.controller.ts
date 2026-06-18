import { Body, Controller, Post } from '@nestjs/common';
import { ExploreService } from './explore.service';

@Controller('explore')
export class ExploreController {
  constructor(private readonly explore: ExploreService) {}

  /** Ask the brain a plain-English question → synthesised answer + sources. */
  @Post('ask')
  async ask(@Body() body: { question?: string }) {
    return this.explore.ask(body?.question || '');
  }
}
