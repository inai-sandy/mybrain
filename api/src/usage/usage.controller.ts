import { Controller, Get } from '@nestjs/common';
import { UsageService } from './usage.service';

@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageService) {}

  /** Live AI spend (OpenRouter app key + credits; OpenAI if an Admin key is connected). Cached ~5 min. */
  @Get()
  async summary() {
    return this.usage.summary();
  }
}
