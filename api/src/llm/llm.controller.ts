import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { TokenBudgetService } from './token-budget.service';
import { LlmService } from './llm.service';
import { ConnectorService } from '../connectors/connector.service';

@Controller('llm-config')
export class LlmController {
  constructor(
    private readonly llm: LlmService,
    private readonly connectors: ConnectorService,
    private readonly budget: TokenBudgetService,
  ) {}

  @Get()
  async get() {
    const cfg = await this.llm.getConfig();
    const status = await this.connectors.listStatus();
    const have = Object.fromEntries(status.map((s) => [s.name, s.configured]));
    return {
      provider: cfg?.provider || null,
      model: cfg?.model || null,
      providers: { anthropic: !!have.anthropic, openrouter: !!have.openrouter },
    };
  }

  /** Agent-helper model pickers (BEA-1106). GET helper/<key> → the saved/default config;
   *  GET helper/<key>s → the model list; PUT helper/<key> {model} saves ('' = back to default). */
  @Get('helper/:key')
  async helperGet(@Param('key') key: string) {
    const bare = key.endsWith('s') ? key.slice(0, -1) : key;
    if (key.endsWith('s') && bare in LlmService.HELPERS) {
      return { models: await this.llm.listOpenRouterModels(['anthropic/', 'openai/', 'google/']) };
    }
    if (!(key in LlmService.HELPERS)) throw new BadRequestException('Unknown helper');
    const cfg = await this.llm.helperModel(key);
    return { provider: cfg?.provider || null, model: cfg?.model || null };
  }

  @Put('helper/:key')
  async helperSet(@Param('key') key: string, @Body() body: { model?: string }) {
    if (!(key in LlmService.HELPERS)) throw new BadRequestException('Unknown helper');
    const cfg = await this.llm.setHelperModel(key, (body?.model || '').trim());
    return { ok: true, ...(cfg || { provider: null, model: null }) };
  }

  @Put()
  async set(@Body() body: { provider?: string; model?: string }) {
    const provider = (body?.provider || '').trim();
    const model = (body?.model || '').trim();
    if (!['anthropic', 'openrouter'].includes(provider)) throw new BadRequestException('Unknown provider');
    if (!model) throw new BadRequestException('Model required');
    await this.llm.setConfig(provider, model);
    return { ok: true, provider, model };
  }

  /** Today's AI spend against the ceiling — so the budget is never a surprise (BEA-1204). */
  @Get('budget')
  async budgetToday() {
    return this.budget.today();
  }

  /** Change the ceilings. 0 switches one off. */
  @Put('budget')
  async setBudget(@Body() b: { day?: number; run?: number }) {
    await this.budget.setLimits(b?.day, b?.run);
    return this.budget.today();
  }

  /**
   * Which engines are actually alive right now (BEA-1201).
   *
   * Codex ran dry on 30 July and nothing on screen said so — every job quietly moved to a paid
   * model for weeks. A picker that implies an engine is working when it is not is worse than no
   * picker at all.
   */
  @Get('engines')
  async engines() {
    const probes: Array<{ name: string; label: string; url: string }> = [
      { name: 'codex', label: 'Codex (ChatGPT plan)', url: process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765' },
      { name: 'claude', label: 'Claude Code (Max plan)', url: process.env.CLAUDE_RUNNER_URL || 'http://172.18.0.1:8768' },
      { name: 'gemini', label: 'Gemini', url: process.env.GEMINI_RUNNER_URL || 'http://172.18.0.1:8767' },
    ];
    const rows = await Promise.all(probes.map(async (p) => {
      try {
        const r = await fetch(`${p.url}/status`, { signal: AbortSignal.timeout(20_000) });
        const d: any = await r.json().catch(() => ({}));
        return { ...p, url: undefined, ready: !!d?.ready, reason: d?.error ? String(d.error).slice(0, 200) : null };
      } catch (e: any) {
        return { ...p, url: undefined, ready: false, reason: `not answering (${String(e?.message || e).slice(0, 60)})` };
      }
    }));
    // The order jobs actually try them in, so the screen matches the behaviour.
    return { chain: rows, fallback: 'A paid model, only when every one of these is unavailable.' };
  }
}
