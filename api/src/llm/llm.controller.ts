import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
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
