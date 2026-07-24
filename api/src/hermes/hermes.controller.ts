import { Body, Controller, Delete, Get, Param, Post, BadRequestException } from '@nestjs/common';
import { HermesBridgeService } from './hermes-bridge.service';
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

  /** Replay a finished run on the same captured input (BEA-1070). */
  @Post('runs/:id/replay')
  async replayRun(@Param('id') id: string) {
    return this.bridge.replayRun(id);
  }

  /** Design (or redesign) the agent's mini-interface (BEA-1082). */
  @Post('agents/:id/ui/generate')
  async generateUi(@Param('id') id: string) {
    return this.bridge.generateUi(id);
  }

  /** Change an agent by chatting (BEA-1065): message → proposed patch + plain-English diff. Nothing saved. */
  @Post('agents/:id/chat')
  async chatEdit(@Param('id') id: string, @Body() body: { message?: string }) {
    if (!body?.message?.trim()) throw new BadRequestException('Say what to change first.');
    return this.bridge.chatEdit(id, body.message.trim());
  }

  /** Run a saved agent now (uses its stored prompt; optional extra input from its mini screen). */
  @Post('agents/:id/run')
  async runAgent(@Param('id') id: string, @Body() body?: { input?: string }) {
    const agent = await this.agent.getAgent(id);
    if (!agent.prompt) throw new BadRequestException('This agent has no task set yet');
    // Honour the agent's default depth (BEA-695). 'deep' agents are run via their flow by the UI; if this
    // single-turn endpoint is hit for one, it falls back to standard depth (non-quick).
    const depth = agent.defaultDepth === 'quick' ? 'quick' : 'standard';
    const extra = body?.input?.trim() ? `\n\n[Your input this run]\n${body.input.trim().slice(0, 2000)}` : '';
    const input = await this.bridge.applyAgentSkills(agent, { prompt: `${agent.prompt}${extra}`, title: agent.name, agentId: agent.id, saveCollectionId: agent.collectionId, rubric: agent.rubric, depth }); // BEA-1079
    return this.bridge.startRun(input);
  }

  // ---- "Saved by agents" trust view (BEA-700) ----
  @Get('saved')
  listSaved() {
    return this.bridge.listSavedByAgents();
  }

  @Delete('saved/doc/:id')
  deleteSavedDoc(@Param('id') id: string) {
    return this.bridge.deleteSavedDocument(id);
  }

  @Post('saved/clear-learnings')
  clearLearnings() {
    return this.bridge.clearAgentLearnings();
  }

  /** Guided builder (BEA-643): draft an agent config from a one-line idea, for the user to review + save. */
  @Post('agents/draft')
  async draftAgent(@Body() body: { idea?: string }) {
    if (!body?.idea?.trim()) throw new BadRequestException('Describe what you want the agent to do.');
    return this.bridge.draftAgent(body.idea.trim());
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

  /** Suggest eval cases from the agent's Task + Outcome (Evals ③). */
  @Post('agents/:id/suggest-evals')
  suggestEvals(@Param('id') id: string) {
    return this.bridge.suggestEvals(id);
  }

  /** Rich engine status for the settings panel + the Agents "engine online" pill. */
  @Get('engine')
  async engine() {
    const [status, counts, health] = await Promise.all([this.codexEngineStatus(), this.agent.engineCounts(), this.agent.engineHealth()]);
    // The agent's My Brain tools are mounted as a host MCP server in the Codex runtime — show them.
    const tools = { ...this.tools.describe(), connected: !!status.connectedToCodex };
    return { ...status, counts, tools, health };
  }

  /** Engine status from the host codex-runner directly (post-Hermes). Shape kept compatible with the UI pill. */
  private async codexEngineStatus() {
    const RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';
    try {
      const r = await fetch(`${RUNNER}/status`, { signal: AbortSignal.timeout(8000) });
      const s: any = r.ok ? await r.json() : {};
      return { ok: !!s.ready, version: s.version || null, model: process.env.AGENT_MODEL || 'gpt-5.5', connectedToCodex: !!s.ready, provider: 'openai-codex', authRequired: !s.loggedIn, gatewayRunning: false };
    } catch {
      return { ok: false, version: null, model: 'gpt-5.5', connectedToCodex: false, provider: 'openai-codex', authRequired: true, gatewayRunning: false };
    }
  }

  /**
   * Engine restart is a no-op now: the engine is the host codex-runner (systemd-managed, auto-restarted
   * on crash) reached per-turn via `codex exec`. The old helper restarted the now-removed Hermes service,
   * so we must NOT call it (that would revive Hermes). Kept so the settings button doesn't 404.
   */
  @Post('engine/restart')
  async restart() {
    return { ok: true, message: 'The Codex runtime is managed automatically — no manual restart needed.' };
  }

  /** Start an agent run: kicks off Hermes in the background, returns the run row immediately. */
  @Post('run')
  run(@Body() body: { prompt?: string; title?: string; agentId?: string; saveCollectionId?: string | null; save?: boolean; quick?: boolean; depth?: 'quick' | 'standard' | 'deep' }) {
    if (!body?.prompt?.trim()) throw new BadRequestException('A prompt is required');
    // Depth model (BEA-695): quick/standard run here as a single turn; legacy `quick` bool maps to depth.
    // 'deep' is a flow — callers route it to the flow endpoints, so it shouldn't reach this handler.
    const depth = body.depth ?? (body.quick ? 'quick' : 'standard');
    return this.bridge.startRun({
      prompt: body.prompt.trim(),
      title: body.title?.trim() || undefined,
      agentId: body.agentId,
      saveCollectionId: body.saveCollectionId ?? null,
      save: depth === 'quick' ? false : body.save,
      depth,
    });
  }
}
