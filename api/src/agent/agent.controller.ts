import { Body, Controller, Get, Param, Patch, Put, Delete, Post, Query, BadRequestException } from '@nestjs/common';
import { AgentService, AskInput } from './agent.service';
import { AgentsImportService } from './agents-import.service';
import { AgentAreasService, AreaTool } from './agent-areas.service';

type AgentInput = { name?: string; prompt?: string; rubric?: string; evals?: unknown[]; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean; defaultDepth?: string; category?: string; color?: string; skills?: unknown[] };

/**
 * Agent HTTP surface (BEA-619). All routes are protected by the global cookie-session guard.
 * The durable run + question state is exposed here for the run screen (BEA-621) and answering
 * in-app; the engine/bridge (BEA-618) and MCP tools (BEA-622) call AgentService directly.
 */
@Controller('agent')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly agentsImport: AgentsImportService,
    private readonly areas: AgentAreasService,
  ) {}

  // ---- agent AREAS (BEA-1095): agent = area, job = the real unit ----

  @Get('areas')
  listAreas() {
    return this.areas.list();
  }

  /** Create a whole agent (area + jobs + tools) from one spec — the skill/chat-builder landing point (BEA-1103). */
  @Post('areas/spec')
  createFromSpec(@Body() body: unknown) {
    return this.areas.createFromSpec(body || {});
  }

  // ---- the in-app chat builder (BEA-1104) ----

  @Get('builder')
  builderState() {
    return this.areas.builderState();
  }

  @Post('builder/chat')
  builderChat(@Body() body: { message?: string }) {
    return this.areas.builderChat(body?.message || '');
  }

  @Post('builder/create')
  builderCreate() {
    return this.areas.builderCreate();
  }

  @Delete('builder')
  builderReset() {
    return this.areas.builderReset();
  }

  @Post('areas')
  createArea(@Body() body: { name?: string; icon?: string; color?: string; description?: string; tools?: AreaTool[]; sourceUrl?: string }) {
    return this.areas.create(body || {});
  }

  @Get('areas/:id')
  getArea(@Param('id') id: string) {
    return this.areas.get(id);
  }

  @Patch('areas/:id')
  updateArea(@Param('id') id: string, @Body() body: { name?: string; icon?: string; color?: string; description?: string; tools?: AreaTool[]; sourceUrl?: string }) {
    return this.areas.update(id, body || {});
  }

  @Delete('areas/:id')
  deleteArea(@Param('id') id: string, @Query('withJobs') withJobs?: string) {
    return this.areas.remove(id, { withJobs: withJobs === '1' || withJobs === 'true' });
  }

  /** Move a job into another agent (regrouping — e.g. OKF under a Research Agent). */
  @Post('agents/:id/move')
  moveJob(@Param('id') id: string, @Body() body: { areaId?: string }) {
    if (!body?.areaId) throw new BadRequestException('Which agent should it move to?');
    return this.areas.moveJob(id, body.areaId);
  }

  /** A job's persisted chat history — clear it (BEA-1097). */
  @Delete('agents/:id/chat-log')
  clearChat(@Param('id') id: string) {
    return this.agent.clearChat(id);
  }

  /** Append a marker line to the chat history (the UI's "Applied ✓" / "left as it was"). */
  @Post('agents/:id/chat-log')
  appendChat(@Param('id') id: string, @Body() body: { text?: string; who?: string }) {
    if (!body?.text?.trim()) throw new BadRequestException('Nothing to add.');
    return this.agent.appendChat(id, [{ who: body.who === 'you' ? 'you' : 'ai', text: body.text.trim() }]);
  }

  // ---- GitHub agent import (BEA-1081) ----

  /** Read a GitHub link: the agents found there + the install plan. Writes nothing. */
  @Post('import/github/preview')
  importPreview(@Body() body: { url?: string }) {
    if (!body?.url?.trim()) throw new BadRequestException('Paste a GitHub link first');
    return this.agentsImport.preview(body.url.trim());
  }

  /** Import the picked agents; install the approved plan on the engine host. */
  @Post('import/github/confirm')
  importConfirm(@Body() body: { url?: string; pick?: string[]; installDeps?: boolean }) {
    if (!body?.url?.trim()) throw new BadRequestException('Missing the GitHub link');
    return this.agentsImport.confirm(body.url.trim(), Array.isArray(body.pick) ? body.pick : [], !!body.installDeps);
  }

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

  /** The whole Agents home in one call: waiting-on-you + running + landed + the shelf. (BEA-1087) */
  @Get('home')
  home() {
    return this.agent.home();
  }

  /** Count of questions waiting on the owner — the nav badge polls this. (BEA-1066) */
  @Get('waiting-count')
  waitingCount() {
    return this.agent.waitingCount();
  }

  /** Every run, agents + flows, one honest history. (BEA-1069) */
  @Get('history')
  history(@Query('limit') limit?: string) {
    return this.agent.allRuns(limit ? Number(limit) : 500);
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
