import { Body, Controller, Get, Param, Patch, Put, Delete, Post, Query, BadRequestException } from '@nestjs/common';
import { AgentService, AskInput } from './agent.service';
import { AgentsImportService } from './agents-import.service';
import { AgentAreasService, AreaTool } from './agent-areas.service';
import { BuilderSampleService } from './builder-sample.service';
import { BriefService } from './brief.service';
import { TOP_BUILDER_SESSION } from './builder-session';

type AgentInput = { name?: string; prompt?: string; rubric?: string; evals?: unknown[]; icon?: string; description?: string; autonomy?: string; schedule?: unknown; scheduleText?: string; collectionId?: string | null; enabled?: boolean; defaultDepth?: string; category?: string; color?: string; skills?: unknown[]; tools?: unknown[]; folderId?: string | null; useWorker?: boolean };

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
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly samples?: BuilderSampleService,
    private readonly briefs?: BriefService,
  ) {}

  // ---- agent AREAS (BEA-1095): agent = area, job = the real unit ----

  @Get('areas')
  listAreas() {
    return this.areas.list();
  }

  // ---- Folders (BEA-1380): flat, owner-made shelves for the agent cards ----

  /** Every folder in order, with counts — plus the All and Unfiled totals. */
  @Get('folders')
  listFolders() {
    return this.areas.listFolders();
  }

  @Post('folders')
  createFolder(@Body() body: { name?: string }) {
    return this.areas.createFolder(body?.name);
  }

  @Patch('folders/:id')
  updateFolder(@Param('id') id: string, @Body() body: { name?: string; order?: number }) {
    return this.areas.updateFolder(id, body || {});
  }

  /** Delete a folder. Its agents are never deleted — they return to Unfiled. */
  @Delete('folders/:id')
  deleteFolder(@Param('id') id: string) {
    return this.areas.deleteFolder(id);
  }

  /** Bulk move: several agent cards into one folder (folderId null/'' = back to Unfiled). */
  @Post('areas/move')
  moveAreas(@Body() body: { ids?: string[]; folderId?: string | null }) {
    return this.areas.moveAreasToFolder(Array.isArray(body?.ids) ? body.ids : [], body?.folderId ?? null);
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
  builderCreate(@Body() body?: { folderId?: string | null }) {
    // `folderId` = the folder the owner was inside when he pressed Create (BEA-1380).
    return this.areas.builderCreate({ folderId: body?.folderId ?? null });
  }

  @Delete('builder')
  builderReset() {
    return this.areas.builderReset();
  }

  /** "Make it an agent" on a Social result (BEA-1372): a fresh conversation seeded with the call just made — no model call. */
  @Post('builder/seed')
  builderSeed(@Body() body: { actionId?: string; args?: Record<string, any>; label?: string; sample?: any }) {
    return this.areas.builderSeed({ actionId: String(body?.actionId || ''), args: body?.args || {}, label: body?.label, sample: body?.sample });
  }

  /** "Look for yourself" — one capped, reads-only sample call charged to the top-level builder conversation (BEA-1370). */
  @Post('builder/sample')
  builderSample(@Body() body: { actionId?: string; args?: Record<string, any> }) {
    if (!this.samples) throw new BadRequestException('Sampling is not available on this server.');
    return this.samples.sample(TOP_BUILDER_SESSION, String(body?.actionId || ''), body?.args || {});
  }

  @Post('areas')
  createArea(@Body() body: { name?: string; icon?: string; color?: string; description?: string; outcome?: string; tools?: AreaTool[]; sourceUrl?: string; folderId?: string | null }) {
    return this.areas.create(body || {});
  }

  // ---- the new-job chat, per agent (BEA-1170) ----
  @Get('areas/:id/job-builder')
  jobBuilderState(@Param('id') id: string) {
    return this.areas.jobBuilderState(id);
  }

  @Post('areas/:id/job-builder/chat')
  jobBuilderChat(@Param('id') id: string, @Body() body: { message?: string }) {
    return this.areas.jobBuilderChat(id, body?.message || '');
  }

  @Post('areas/:id/job-builder/create')
  jobBuilderCreate(@Param('id') id: string, @Body() body: { tools?: string[]; checks?: string[] }) {
    return this.areas.jobBuilderCreate(id, body || {});
  }

  @Delete('areas/:id/job-builder')
  jobBuilderReset(@Param('id') id: string) {
    return this.areas.jobBuilderReset(id);
  }

  /** The same sample call, charged to this area's job-builder conversation (BEA-1370). */
  @Post('areas/:id/job-builder/sample')
  jobBuilderSample(@Param('id') id: string, @Body() body: { actionId?: string; args?: Record<string, any> }) {
    if (!this.samples) throw new BadRequestException('Sampling is not available on this server.');
    return this.samples.sample(id, String(body?.actionId || ''), body?.args || {});
  }

  // ---- the brief (BEA-1405) — what the owner reads and approves before anything is built ----
  //
  // The screen that draws these is BEA-1406. Every route answers the whole brief, so the screen
  // never has to stitch two answers together and can never show a half-updated page.

  @Get('areas/:id/brief')
  async brief(@Param('id') id: string) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const brief = (await this.briefs.latest(id)) || (await this.briefs.draft(id));
    return { brief, refusals: await this.briefs.whyNot(brief.id) };
  }

  @Post('areas/:id/brief')
  async briefUpdate(@Param('id') id: string, @Body() body: { name?: string; sections?: any; sources?: any; delivery?: any; transcript?: any }) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const current = (await this.briefs.latest(id)) || (await this.briefs.draft(id));
    const brief = await this.briefs.update(current.id, body || {});
    return { brief, refusals: await this.briefs.whyNot(brief.id) };
  }

  @Post('areas/:id/brief/line')
  async briefAddLine(@Param('id') id: string, @Body() body: { section?: string; text?: string; origin?: string }) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const current = (await this.briefs.latest(id)) || (await this.briefs.draft(id));
    const section = String(body?.section || '') as any;
    // A line added by hand is HIS unless the caller says otherwise — the safe default for a screen.
    const origin = body?.origin === 'ai' || body?.origin === 'tool' ? (body.origin as any) : 'owner';
    const brief = await this.briefs.addLine(current.id, section, String(body?.text || ''), origin);
    return { brief, refusals: await this.briefs.whyNot(brief.id) };
  }

  @Patch('areas/:id/brief/line/:lineId')
  async briefEditLine(@Param('id') id: string, @Param('lineId') lineId: string, @Body() body: { text?: string }) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const current = (await this.briefs.latest(id)) || (await this.briefs.draft(id));
    const brief = await this.briefs.editLine(current.id, lineId, String(body?.text || ''));
    return { brief, refusals: await this.briefs.whyNot(brief.id) };
  }

  /** Kill a line, or bring it back. It is marked, never deleted. */
  @Post('areas/:id/brief/line/:lineId/strike')
  async briefStrike(@Param('id') id: string, @Param('lineId') lineId: string, @Body() body: { struck?: boolean }) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const current = (await this.briefs.latest(id)) || (await this.briefs.draft(id));
    const brief = await this.briefs.strike(current.id, lineId, body?.struck !== false);
    return { brief, refusals: await this.briefs.whyNot(brief.id) };
  }

  /** Look at a source for real, and write down what it actually showed. Rule one. */
  @Post('areas/:id/brief/look')
  async briefLook(@Param('id') id: string, @Body() body: { actionId?: string; args?: Record<string, any>; sourceId?: string }) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const current = (await this.briefs.latest(id)) || (await this.briefs.draft(id));
    const actionId = String(body?.actionId || '');
    const args = body?.args || {};
    const { view, saw, evidence } = await this.briefs.look(id, actionId, args);
    // A refused or failed look records nothing: an unproved source must stay unproved.
    const brief = evidence
      ? await this.briefs.noteSource(current.id, { id: String(body?.sourceId || actionId), actionId, args, evidence, saw })
      : current;
    return { brief, view, refusals: await this.briefs.whyNot(brief.id) };
  }

  /** The call a "looked" line leans on — one tap turns a claim into something he can check. */
  @Get('areas/:id/brief/proof/:callId')
  async briefProof(@Param('callId') callId: string) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const proof = await this.briefs.proof(callId);
    if (!proof) throw new BadRequestException('That look is not on record any more.');
    return proof;
  }

  @Post('areas/:id/brief/approve')
  async briefApprove(@Param('id') id: string) {
    if (!this.briefs) throw new BadRequestException('Briefs are not available on this server.');
    const current = (await this.briefs.latest(id)) || (await this.briefs.draft(id));
    const out = await this.briefs.approve(current.id);
    return { ok: out.ok, brief: out.brief || current, refusals: out.refusals || [] };
  }

  @Get('areas/:id')
  getArea(@Param('id') id: string) {
    return this.areas.get(id);
  }

  @Patch('areas/:id')
  updateArea(@Param('id') id: string, @Body() body: { name?: string; icon?: string; color?: string; description?: string; outcome?: string; tools?: AreaTool[]; sourceUrl?: string; folderId?: string | null }) {
    return this.areas.update(id, body || {});
  }

  /** Copy an agent's identity + toolbox as a starting point; its jobs are not copied (BEA-1182). */
  @Post('areas/:id/duplicate')
  duplicateArea(@Param('id') id: string) {
    return this.areas.duplicate(id);
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
