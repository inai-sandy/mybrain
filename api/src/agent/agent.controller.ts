import { Body, Controller, Get, Param, Patch, Put, Delete, Post, Query, BadRequestException } from '@nestjs/common';
import { AgentService, AskInput } from './agent.service';

type AgentInput = { name?: string; prompt?: string; rubric?: string; evals?: unknown[]; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean; defaultDepth?: string };

/**
 * Agent HTTP surface (BEA-619). All routes are protected by the global cookie-session guard.
 * The durable run + question state is exposed here for the run screen (BEA-621) and answering
 * in-app; the engine/bridge (BEA-618) and MCP tools (BEA-622) call AgentService directly.
 */
@Controller('agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  // ---- engine settings ----

  @Get('settings')
  getSettings() {
    return this.agent.engineSettings();
  }

  @Put('settings')
  setSettings(@Body() body: Record<string, unknown>) {
    return this.agent.setEngineSettings(body || {});
  }

  @Get('models')
  models() {
    return [
      { value: '', label: 'Engine default' },
      { value: 'gpt-5.5', label: 'GPT-5.5 (most capable)' },
      { value: 'gpt-5.4', label: 'GPT-5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini (fast)' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' },
    ];
  }

  // ---- saved agents (BEA-623) ----

  @Get('agents')
  listAgents() {
    return this.agent.listAgents();
  }

  @Post('agents')
  createAgent(@Body() body: AgentInput) {
    if (!body?.name) throw new BadRequestException('An agent needs a name');
    return this.agent.createAgent(body as any);
  }

  @Get('agents/:id')
  getAgent(@Param('id') id: string) {
    return this.agent.getAgent(id);
  }

  @Patch('agents/:id')
  updateAgent(@Param('id') id: string, @Body() body: AgentInput) {
    return this.agent.updateAgent(id, body);
  }

  @Delete('agents/:id')
  deleteAgent(@Param('id') id: string) {
    return this.agent.deleteAgent(id);
  }

  // ---- runs ----

  @Get('runs')
  listRuns(@Query('agentId') agentId?: string, @Query('limit') limit?: string) {
    return this.agent.listRuns({ agentId: agentId || undefined, limit: limit ? Number(limit) : undefined });
  }

  @Post('runs')
  createRun(@Body() body: { agentId?: string; title?: string; input?: string }) {
    return this.agent.createRun(body || {});
  }

  /** Clear finished runs (all, or one agent's via ?agentId=). In-flight runs are kept. */
  @Delete('runs')
  clearRuns(@Query('agentId') agentId?: string) {
    return this.agent.clearRuns(agentId || undefined);
  }

  /** Delete one run. Refuses if it's still in progress. */
  @Delete('runs/:id')
  deleteRun(@Param('id') id: string) {
    return this.agent.deleteRun(id);
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
