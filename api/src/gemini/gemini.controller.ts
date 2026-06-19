import { Controller, Get } from '@nestjs/common';
import { GeminiService } from './gemini.service';

@Controller('gemini')
export class GeminiController {
  constructor(private readonly gemini: GeminiService) {}

  /** Is the host Antigravity CLI installed / logged in / ready? Drives the Settings card. */
  @Get('status')
  async status() {
    return this.gemini.status();
  }
}
