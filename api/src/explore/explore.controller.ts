import { BadRequestException, Body, Controller, Get, Param, Post, Put } from '@nestjs/common';
import { ExploreService } from './explore.service';

@Controller('explore')
export class ExploreController {
  constructor(private readonly explore: ExploreService) {}

  // --- answer model (cost control: Sonnet ⇄ Haiku) ---
  @Get('model')
  async getModel() {
    return this.explore.getModel();
  }
  @Put('model')
  async setModel(@Body() body: { provider?: string; model?: string }) {
    if (!body?.model) throw new BadRequestException('Pick a model');
    return this.explore.setModel(body.provider || 'openrouter', body.model);
  }
  @Get('models')
  async models() {
    return { models: await this.explore.listModels() };
  }

  /** Ask the brain a plain-English question → synthesised answer + sources. */
  @Post('ask')
  async ask(@Body() body: { question?: string }) {
    return this.explore.ask(body?.question || '');
  }

  /** Index manager: per-section status (counts, last-indexed, enabled). (BEA-335) */
  @Get('sources')
  async sources() {
    return this.explore.sources();
  }

  /** Enable/disable a section (disable purges from search; enable re-indexes). */
  @Post('sources/:type')
  async setSource(@Param('type') type: string, @Body() body: { enabled?: boolean }) {
    return this.explore.setSource(type, !!body?.enabled);
  }

  /** Re-index one section now. */
  @Post('sources/:type/reindex')
  async reindex(@Param('type') type: string) {
    return this.explore.reindex(type);
  }

  /** Start the one-time re-chunk optimize of existing docs (BEA-337). */
  @Post('rechunk')
  async rechunk() {
    return this.explore.startRechunk();
  }

  @Get('rechunk-status')
  async rechunkStatus() {
    return this.explore.rechunkStatus();
  }
}
