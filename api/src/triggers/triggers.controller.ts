import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { TriggersService } from './triggers.service';

/**
 * The trigger endpoints (BEA-1350). Design: `specs/TOOLS.md` → Triggers.
 *
 * Everything here is owner-only and behind the normal session guard, **except the one route the
 * provider posts to**. That one cannot be: it is called by a machine on the public internet with no
 * session of ours, so it is marked `@Public()` and its only door is the secret in its own URL —
 * which is the same shape the document ingest endpoint has used since BEA-535.
 *
 * The webhook answers straight away and does the work behind it. A provider that is kept waiting
 * retries, and a retried event is a second run of the same flow.
 */
@Controller('tools/triggers')
export class TriggersController {
  constructor(private readonly triggers: TriggersService) {}

  // ---- the public door ---------------------------------------------------------------------

  /**
   * Where the provider posts events. The last path segment IS the secret.
   *
   * Throttled as well as secret-checked: this URL is on the public internet, and a wrong secret
   * costs one string comparison, not a database read.
   *
   * The answer is sent BEFORE the work — 202, meaning "I have it". Holding the connection open
   * while a flow starts invites the provider's own retry, and a retry is a duplicate run.
   */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('events/:secret')
  async event(@Param('secret') secret: string, @Req() req: Request, @Res() res: Response) {
    if (!(await this.triggers.verifySecret(secret))) {
      res.status(401).json({ ok: false, message: 'Not authorised.' });
      return;
    }
    res.status(202).json({ ok: true });
    // Deliberately not awaited: the answer is already on the wire.
    void this.triggers.handle({ body: req.body, secret }).catch(() => undefined);
  }

  /** A wrong URL is the common shape of a wrong secret. Same answer, and nothing runs. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Post('events')
  noSecret(@Res() res: Response) {
    res.status(401).json({ ok: false, message: 'Not authorised.' });
  }

  // ---- owner-only ---------------------------------------------------------------------------

  /** Is event delivery set up, and where does it point? Never the secret itself. */
  @Get('status')
  status() {
    return this.triggers.status();
  }

  /** The rules the owner has made — all of them, or one service's. */
  @Get()
  list(@Query('service') service?: string) {
    return this.triggers.list(service);
  }

  /** The whole history, newest first, for the "what has been happening" view. */
  @Get('events')
  allEvents(@Query('limit') limit?: string) {
    return this.triggers.events(undefined, Number(limit) || 50);
  }

  /** What one service can tell us about. An empty list is a real answer — some services have none. */
  @Get('available/:service')
  available(@Param('service') service: string) {
    return this.triggers.available(String(service || ''));
  }

  @Post()
  create(@Body() body: { service?: string; triggerType?: string; flowId?: string; config?: Record<string, any>; accountId?: string; label?: string; rateCap?: number }) {
    return this.triggers.create(body || {});
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { enabled?: boolean; rateCap?: number; label?: string; config?: Record<string, any> }) {
    return this.triggers.update(String(id || ''), body || {});
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.triggers.remove(String(id || ''));
  }

  /** What has arrived for one rule. */
  @Get(':id/events')
  events(@Param('id') id: string, @Query('limit') limit?: string) {
    return this.triggers.events(String(id || ''), Number(limit) || 50);
  }
}
