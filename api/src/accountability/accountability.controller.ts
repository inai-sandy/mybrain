import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { AccountabilityService } from './accountability.service';

@Controller('accountability')
export class AccountabilityController {
  constructor(private readonly acc: AccountabilityService) {}

  @Get('commitments')
  commitments(@Query('filter') filter?: string) {
    return this.acc.listCommitments(filter || 'all');
  }

  @Get('decisions')
  decisions() {
    return this.acc.listDecisions();
  }

  /** Re-scan a day (defaults to today) for commitments + decisions. */
  @Post('extract')
  extract(@Body() body: { day?: string }) {
    return this.acc.extractForDay(body?.day);
  }

  @Patch('commitments/:id')
  async patch(@Param('id') id: string, @Body() body: { status?: string; confirm?: boolean }) {
    if (body?.confirm) await this.acc.confirm(id);
    if (body?.status) await this.acc.setStatus(id, body.status);
    return { ok: true };
  }

  @Delete('commitments/:id')
  removeCommitment(@Param('id') id: string) {
    return this.acc.removeCommitment(id);
  }
  @Delete('decisions/:id')
  removeDecision(@Param('id') id: string) {
    return this.acc.removeDecision(id);
  }
}
