import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { AgentService } from '../agent/agent.service';
import { ToolKnowledgeService } from '../tools/tool-knowledge.service';
import { AgentPlan, PlanCost, estimatePlanCost, planActionIds, planFromAgent } from './plan';
import { SocialWatchStore } from './social-watch.store';
import { SocialService } from './social.service';

/**
 * The Social section's routes (BEA-1356). Thin on purpose: every answer is `SocialService`'s, and
 * a run goes through the ONE run path (`ServiceActionsService.runDetailed()`), so the `ToolCall`
 * row is written the same way an agent's is. No vendor name appears in a route.
 */
@Controller('social')
export class SocialController {
  constructor(
    private readonly social: SocialService,
    private readonly watches: SocialWatchStore,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly agents?: AgentService,
    private readonly knowledge?: ToolKnowledgeService,
  ) {}

  /**
   * The plan a Social job runs and ≈ what one run costs (BEA-1369): `planFromAgent()` over the saved
   * job, credits from the know-how cards when they say (pages × credits per page; creators-first =
   * finder + one per creator), AI tokens for the shaping step. The job page shows "≈ N credits per run".
   */
  @Get('plan/:agentId')
  async plan(@Param('agentId') agentId: string): Promise<{ plan: AgentPlan; cost: PlanCost }> {
    const agent = await this.agents?.getAgent?.(String(agentId || ''));
    if (!agent) throw new NotFoundException('No such agent');
    const plan = planFromAgent(agent);
    const cards = await this.knowledge?.lookup?.(planActionIds(plan)).catch(() => []);
    // name + health too (BEA-1375): the estimate says what the run costs TODAY while a source is down.
    const knowledge = Object.fromEntries((cards || []).map((c) => [c.actionId, { name: c.name, cost: c.cost, paging: c.paging, health: c.health }]));
    return { plan, cost: estimatePlanCost(plan, knowledge) };
  }

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

  /** What a Watch/Alert job saw last time (BEA-1358) — for the job's Settings ("watching since …"). */
  @Get('watch/:agentId')
  async watch(@Param('agentId') agentId: string) {
    return { rows: await this.watches.listForAgent(String(agentId || '')) };
  }

  /** Forget what a Watch/Alert job saw — its next run is a baseline again (BEA-1358). */
  @Delete('watch/:agentId')
  async resetWatch(@Param('agentId') agentId: string) {
    return { ok: true, removed: await this.watches.reset(String(agentId || '')) };
  }

  /** Run one endpoint with the form's values. Answers a shape, never throws a raw error at the page. */
  @Post('run')
  run(@Body() body: { actionId?: string; args?: Record<string, any> }) {
    return this.social.run(String(body?.actionId || ''), body?.args && typeof body.args === 'object' ? body.args : {});
  }
}
