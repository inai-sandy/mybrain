import { Controller, Get } from '@nestjs/common';
import { CodexService } from './codex.service';

@Controller('codex')
export class CodexController {
  constructor(private readonly codex: CodexService) {}

  /** Is the host Codex installed / logged in / ready? Drives the Settings card. */
  @Get('status')
  async status() {
    return this.codex.status();
  }
}
