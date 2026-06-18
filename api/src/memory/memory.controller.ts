import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { MemoryService } from './memory.service';

@Controller('memory')
export class MemoryController {
  constructor(private readonly mem: MemoryService) {}

  /** Enqueue a test doc and drain immediately — used to verify the dual-write end to end. */
  @Post('ping')
  async ping(@Body() body: { text?: string }) {
    const text = body?.text || `My Brain memory ping ${new Date().toISOString()}`;
    await this.mem.enqueue(text, { title: 'memory-ping', tags: ['mybrain-test'] });
    const r = await this.mem.drain();
    return { queued: true, drained: r.processed, status: await this.mem.status() };
  }

  @Get('status')
  async status() {
    return { outbox: await this.mem.status(), unindexed: await this.mem.unindexedCounts() };
  }

  /** Manually run the repair sweep: revive failed writes + re-enqueue any unlinked row. (BEA-333) */
  @Post('reconcile')
  async reconcile() {
    return this.mem.reconcile();
  }

  /** Just reset failed outbox rows back to pending. */
  @Post('retry')
  async retry() {
    return this.mem.retryFailed();
  }

  /** Browse the user's existing SuperMemory documents + total count. */
  @Get('browse')
  async browse(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.mem.browseSuperMemory(Number(limit) || 50, Number(page) || 1);
  }

  @Get('search')
  async search(@Query('q') q: string) {
    return this.mem.searchBoth(q || 'test');
  }
}
