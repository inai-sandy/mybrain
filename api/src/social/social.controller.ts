import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { SocialService } from './social.service';

/**
 * The Social section's routes (BEA-1356). Thin on purpose: every answer is `SocialService`'s, and
 * a run goes through the ONE run path (`ServiceActionsService.runDetailed()`), so the `ToolCall`
 * row is written the same way an agent's is. No vendor name appears in a route.
 */
@Controller('social')
export class SocialController {
  constructor(private readonly social: SocialService) {}

  /** The grid page in one answer: key state, balance, today's spend, the ceiling, every platform. */
  @Get()
  overview(@Query('refresh') refresh?: string) {
    return this.social.overview(!!refresh);
  }

  /** The three numbers on their own — re-read after a run. */
  @Get('spend')
  spend() {
    return this.social.spend();
  }

  /** One platform and every endpoint it has, with the schema each form is generated from. */
  @Get('platforms/:slug')
  async platform(@Param('slug') slug: string) {
    const r = await this.social.platform(String(slug || ''));
    if (!r) return { platform: null, actions: [], message: `We do not know a platform called "${slug}".` };
    return r;
  }

  /** Run one endpoint with the form's values. Answers a shape, never throws a raw error at the page. */
  @Post('run')
  run(@Body() body: { actionId?: string; args?: Record<string, any> }) {
    return this.social.run(String(body?.actionId || ''), body?.args && typeof body.args === 'object' ? body.args : {});
  }
}
