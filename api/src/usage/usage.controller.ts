import { Controller, Get, Query } from '@nestjs/common';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** Live AI spend (OpenRouter app key + credits; OpenAI if an Admin key is connected). Cached ~5 min. */
  @Get()
  async summary() {
    return this.usage.summary();
  }

  /** Per-feature cost totals from the app's own request log. */
  @Get('features')
  async features(@Query('days') days?: string) {
    return this.usage.features(days ? Number(days) : 7);
  }

  /** Recent individual AI requests (newest first). */
  @Get('requests')
  async requests(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('feature') feature?: string) {
    return this.usage.requests(limit ? Number(limit) : 25, offset ? Number(offset) : 0, feature || undefined);
  }
}
