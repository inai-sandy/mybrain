import { Body, Controller, Get, Param, Post, BadRequestException } from '@nestjs/common';
import { HermesBridgeService } from './hermes-bridge.service';
import { HermesClient } from './hermes.client';
import { AgentService } from '../agent/agent.service';
import { AgentToolsService } from '../agent/agent-tools.service';
import { MemoryService } from '../memory/memory.service';

/**
 * Agent run endpoints backed by the Hermes engine (BEA-618). Behind the global auth guard.
 * Kept on the `agent` prefix alongside the run/waitpoint endpoints from BEA-619.
 */
@Controller('agent')
export class HermesController {
  constructor(
    private readonly bridge: HermesBridgeService,
    private readonly hermes: HermesClient,
    private readonly agent: AgentService,
    private readonly tools: AgentToolsService,
    private readonly memory: MemoryService,
  ) {}

  /** Keep / forget the learnings a run proposed (BEA-624). Kept ones are written to memory. */
  @Post('runs/:id/learnings')
  async resolveLearnings(@Param('id') id: string, @Body() body: { items?: Array<{ text: string; keep: boolean }> }) {
    await this.agent.getRun(id); // 404 if the run is gone
    const items = (body?.items || []).filter((i) => i?.text?.trim());
    const out: Array<{ text: string; status: string }> = [];
    for (const i of items) {
      if (i.keep) {
        await this.memory.enqueue(i.text.trim(), { refType: 'agent-learning', refId: id, title: 'Agent learned', tags: ['agent', 'learning'] }).catch(() => undefined);
        out.push({ text: i.text.trim(), status: 'kept' });
      } else {
        out.push({ text: i.text.trim(), status: 'forgotten' });
      }
    }
    await this.agent.setLearnings(id, out);
    return { ok: true, kept: out.filter((o) => o.status === 'kept').length };
  }

  /** Run a saved agent now (uses its stored prompt). */
  @Post('agents/:id/run')
  async runAgent(@Param('id') id: string) {
    const agent = await this.agent.getAgent(id);
    if (!agent.prompt) throw new BadRequestException('This agent has no task set yet');
    return this.bridge.startRun({ prompt: agent.prompt, title: agent.name, agentId: agent.id, saveCollectionId: agent.collectionId, rubric: agent.rubric });
  }

  /** Run every saved eval case for an agent and grade each against the Outcome (BEA-642). Background. */
  @Post('agents/:id/run-evals')
  async runEvals(@Param('id') id: string) {
    const agent: any = await this.agent.getAgent(id);
    const n = Array.isArray(agent.evals) ? agent.evals.length : 0;
    if (!n) throw new BadRequestException('Add at least one eval case first.');
    if (!agent.rubric) throw new BadRequestException('Set an Outcome first so the evals can be graded.');
    void this.bridge.runEvals(id).catch(() => undefined);
    return { started: n };
  }

  /** Rich engine status for the settings panel + the Agents "engine online" pill. */
  @Get('engine')
  async engine() {
    const [status, counts, health] = await Promise.all([this.hermes.engineStatus(), this.agent.engineCounts(), this.agent.engineHealth()]);
    // The agent's My Brain tools are mounted as a host MCP server in the Codex runtime — show them.
    const tools = { ...this.tools.describe(), connected: !!status.connectedToCodex };
    return { ...status, counts, tools, health };
  }

  /** Restart the engine via the locked-down host helper (it only runs `systemctl restart mybrain-agent`). */
  @Post('engine/restart')
  async restart() {
    const url = process.env.AGENT_HELPER_URL || 'http://172.18.0.1:8770';
    const token = process.env.AGENT_HELPER_TOKEN || '';
    try {
      const r = await fetch(`${url}/restart`, { method: 'POST', headers: { 'x-token': token }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error('helper returned ' + r.status);
      return { ok: true };
    } catch (e: any) {
      throw new BadRequestException('Could not restart the engine — ' + (e?.message || 'helper unreachable'));
    }
  }

  /** Start an agent run: kicks off Hermes in the background, returns the run row immediately. */
  @Post('run')
  run(@Body() body: { prompt?: string; title?: string; agentId?: string; saveCollectionId?: string | null; save?: boolean; quick?: boolean }) {
    if (!body?.prompt?.trim()) throw new BadRequestException('A prompt is required');
    return this.bridge.startRun({
      prompt: body.prompt.trim(),
      title: body.title?.trim() || undefined,
      agentId: body.agentId,
      saveCollectionId: body.saveCollectionId ?? null,
      save: body.quick ? false : body.save,
      quick: body.quick,
    });
  }
}
