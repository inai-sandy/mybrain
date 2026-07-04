import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { FlowsService } from './flows.service';
import { FlowRunnerService } from './flows-runner.service';

@Controller('flows')
export class FlowsController {
  constructor(
    private readonly flows: FlowsService,
    private readonly runner: FlowRunnerService,
  ) {}

  @Get()
  async list(@Query('agentId') agentId?: string) {
    return { flows: await this.flows.list(agentId) };
  }

  // static routes before :id
  @Get('palette')
  palette() {
    return this.flows.palette();
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
  update(@Param('id') id: string, @Body() body: { name?: string; question?: string; graph?: unknown; schedule?: unknown }) {
    return this.flows.update(id, body || {});
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.flows.remove(id);
  }
}
