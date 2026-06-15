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

  /** Per-feature cost totals from the app's own request log (optionally over a date range). */
  @Get('features')
  async features(@Query('days') days?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.usage.features(days ? Number(days) : 7, from, to);
  }

  /** Individual AI/transcription requests (newest first), paginated + filterable by feature and date. */
  @Get('requests')
  async requests(@Query('limit') limit?: string, @Query('offset') offset?: string, @Query('feature') feature?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.usage.requests(limit ? Number(limit) : 25, offset ? Number(offset) : 0, feature || undefined, from, to);
  }
}
