import { Body, Controller, Get, Post, BadRequestException } from '@nestjs/common';
import { HermesBridgeService } from './hermes-bridge.service';
import { HermesClient } from './hermes.client';

/**
 * Agent run endpoints backed by the Hermes engine (BEA-618). Behind the global auth guard.
 * Kept on the `agent` prefix alongside the run/waitpoint endpoints from BEA-619.
 */
@Controller('agent')
export class HermesController {
  constructor(
    private readonly bridge: HermesBridgeService,
    private readonly hermes: HermesClient,
  ) {}

  /** Is the engine reachable? (the Agents UI shows an "engine offline" banner otherwise). */
  @Get('engine')
  engine() {
    return this.hermes.ping();
  }

  /** Start an agent run: kicks off Hermes in the background, returns the run row immediately. */
  @Post('run')
  run(@Body() body: { prompt?: string; title?: string; agentId?: string; saveCollectionId?: string | null; save?: boolean }) {
    if (!body?.prompt?.trim()) throw new BadRequestException('A prompt is required');
    return this.bridge.startRun({
      prompt: body.prompt.trim(),
      title: body.title?.trim() || undefined,
      agentId: body.agentId,
      saveCollectionId: body.saveCollectionId ?? null,
      save: body.save,
    });
  }
}
