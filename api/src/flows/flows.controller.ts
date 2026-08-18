import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { sendJson } from '../common/send-json';
import { FlowsService } from './flows.service';
import { FlowRunnerService } from './flows-runner.service';
import { AgentFlowSyncService } from './agent-flow-sync.service';

@Controller('flows')
export class FlowsController {
  constructor(
    private readonly flows: FlowsService,
    private readonly runner: FlowRunnerService,
    private readonly sync?: AgentFlowSyncService, // optional + LAST — spec files construct positionally
  ) {}

  /**
   * Draw / re-draw an agent's flow picture on request (BEA-1366) — one road for both kinds: a
   * Social agent is rebuilt from its settings (no AI), any other agent is (re)planned in the
   * background and answers `drawStatus:'drawing'`. `flow:null` = nothing to draw from yet.
   */
  @Post('agents/:agentId/draw')
  async draw(@Param('agentId') agentId: string) {
    if (!this.sync) throw new BadRequestException('Drawing is not available on this server.');
    return { flow: await this.sync.drawFor(agentId) };
  }

  @Get()
  async list(@Query('agentId') agentId?: string) {
    return { flows: await this.flows.list(agentId) };
  }

  // static routes before :id
  /** Gzipped on the wire — the palette carries the whole catalog (BEA-1354, ~360KB plain). */
  @Get('palette')
  async palette(@Res() res: Response) {
    sendJson(res, await this.flows.palette());
  }

  @Post('decompose')
  async decompose(@Body() body: { question?: string }) {
    if (!body?.question?.trim()) throw new BadRequestException('Type a question first.');
    return { subquestions: await this.flows.decompose(body.question.trim()) };
  }

  // plan a complete flow from the flow's question (Agent↔Flow merge ②)
  @Post(':id/plan')
  plan(@Param('id') id: string) {
    return this.flows.planAndSave(id);
  }

  // canvas → words (BEA-1065): preview the rewritten agent Task for this flow; apply only on confirm
  @Post(':id/sync-agent/preview')
  syncAgentPreview(@Param('id') id: string) {
    return this.flows.syncAgentPreview(id);
  }
  @Post(':id/sync-agent/apply')
  syncAgentApply(@Param('id') id: string, @Body() body: { task?: string }) {
    return this.flows.syncAgentApply(id, (body?.task ?? '').toString());
  }

  // a self-contained copy-paste prompt built from the flow (Agent↔Flow merge ③)
  @Get(':id/prompt')
  prompt(@Param('id') id: string) {
    return this.flows.getPrompt(id);
  }

  // recent runs of a flow + the documents each produced (Agent↔Flow merge ④)
  @Get(':id/runs')
  async runs(@Param('id') id: string) {
    return { runs: await this.runner.listRuns(id) };
  }

  // clear a flow's finished runs (in-flight ones are kept)
  @Delete(':id/runs')
  clearRuns(@Param('id') id: string) {
    return this.runner.clearRuns(id);
  }

  // delete one flow run (refuses while running/waiting)
  @Delete('runs/:runId')
  deleteRun(@Param('runId') runId: string) {
    return this.runner.deleteRun(runId);
  }

  // answer an open "Ask me" pause and resume the run (Move B)
  @Post('runs/:runId/answer')
  answer(@Param('runId') runId: string, @Body() body: { answer?: string }) {
    return this.runner.answer(runId, (body?.answer ?? '').toString());
  }

  // replay: run the same flow again from a past run's row (BEA-1070)
  @Post('runs/:runId/replay')
  replay(@Param('runId') runId: string) {
    return this.runner.replay(runId);
  }

  // "Run to here": test one block with only its upstream feeders, honouring frozen pins (BEA-1072)
  @Post(':id/test-node')
  testNode(@Param('id') id: string, @Body() body: { nodeId?: string }) {
    if (!body?.nodeId) throw new BadRequestException('Which block?');
    return this.runner.testToNode(id, body.nodeId);
  }

  // cancel a running/waiting run so the flow is free to run again (BEA-776)
  @Post('runs/:runId/cancel')
  cancel(@Param('runId') runId: string) {
    return this.runner.cancelRun(runId);
  }

  // run an agent's eval cases through its flow (Evals ①). Background; UI polls the agent for progress.
  @Post('agents/:agentId/run-evals')
  runAgentEvals(@Param('agentId') agentId: string) {
    return this.runner.runAgentEvals(agentId);
  }

  @Get('runs/:runId')
  getRun(@Param('runId') runId: string) {
    return this.runner.getRun(runId);
  }

  @Post()
  create(@Body() body: { name?: string; question?: string; graph?: unknown; agentId?: string }) {
    return this.flows.create(body || {});
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.flows.get(id);
  }

  @Post(':id/run')
  run(@Param('id') id: string, @Body() body?: { skipBranches?: number[] }) {
    return this.runner.start(id, { skipBranches: Array.isArray(body?.skipBranches) ? body!.skipBranches : undefined });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: { name?: string; question?: string; graph?: unknown; schedule?: unknown; locked?: boolean }) {
    return this.flows.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.flows.remove(id);
  }
}
