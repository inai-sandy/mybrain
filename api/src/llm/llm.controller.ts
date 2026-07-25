import { BadRequestException, Body, Controller, Get, Param, Put } from '@nestjs/common';
import { LlmService } from './llm.service';
import { ConnectorService } from '../connectors/connector.service';

@Controller('llm-config')
export class LlmController {
  constructor(
    private readonly llm: LlmService,
    private readonly connectors: ConnectorService,
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
}
