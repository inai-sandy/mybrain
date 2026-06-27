import { Body, Controller, Get, Param, Post, Query, BadRequestException } from '@nestjs/common';
import { AgentService, AskInput } from './agent.service';

/**
 * Agent HTTP surface (BEA-619). All routes are protected by the global cookie-session guard.
 * The durable run + question state is exposed here for the run screen (BEA-621) and answering
 * in-app; the engine/bridge (BEA-618) and MCP tools (BEA-622) call AgentService directly.
 */
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  // ---- runs ----

  @Get('runs')
  listRuns(@Query('agentId') agentId?: string, @Query('limit') limit?: string) {
    return this.agent.listRuns({ agentId: agentId || undefined, limit: limit ? Number(limit) : undefined });
  }

  @Post('runs')
  createRun(@Body() body: { agentId?: string; title?: string; input?: string }) {
    return this.agent.createRun(body || {});
  }

  @Get('runs/:id')
  getRun(@Param('id') id: string) {
    return this.agent.getRun(id);
  }

  @Post('runs/:id/cancel')
  cancelRun(@Param('id') id: string) {
    return this.agent.cancelRun(id);
  }

  /** Pause a run on a question (used by the engine/integration; returns the waitpoint). */
  @Post('runs/:id/ask')
  ask(@Param('id') id: string, @Body() body: AskInput) {
    if (!body?.question) throw new BadRequestException('A question is required');
    return this.agent.ask(id, body);
  }

  // ---- answering a question ----

  /** Answer the currently-open question on a run, by waitpoint id (in-app run screen). */
  @Post('waitpoints/:id/answer')
  answerById(@Param('id') id: string, @Body() body: { answer?: unknown; via?: string }) {
    return this.agent.answerById(id, body?.answer, body?.via || 'web');
  }

  /** Answer by one-time resume token (Telegram tap / resume link). */
  @Post('waitpoints/answer')
  answerByToken(@Body() body: { token?: string; answer?: unknown; via?: string }) {
    if (!body?.token) throw new BadRequestException('Missing token');
    return this.agent.answerByToken(body.token, body?.answer, body?.via || 'web');
  }
}
