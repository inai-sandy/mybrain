import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { EmoCardsService, EmoLane, EmoStatus } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';

/** EMO section API (BEA-862/863) — the feed reads/acts on cards; /capture routes a transcript to cards. */
@Controller('emo')
export class EmoController {
  constructor(
    private readonly cards: EmoCardsService,
    private readonly router: EmoRouterService,
  ) {}

  // The seam the capture pipeline (EMO 4) calls: a transcript → one or more cards via the AI router.
  @Post('capture')
  capture(@Body() body: { transcript?: string; source?: string; audioPath?: string }) {
    const transcript = (body?.transcript ?? '').toString().trim();
    if (!transcript) throw new BadRequestException('transcript is required');
    return this.router.route(transcript, { source: body?.source, audioPath: body?.audioPath });
  }

  @Get('cards')
  list(@Query('status') status?: EmoStatus, @Query('lane') lane?: EmoLane, @Query('day') day?: string, @Query('take') take?: string, @Query('skip') skip?: string) {
    return this.cards.list({ status, lane, day, take: take ? Number(take) : undefined, skip: skip ? Number(skip) : undefined });
  }

  @Get('counts')
  counts() {
    return this.cards.counts();
  }

  @Get('cards/:id')
  get(@Param('id') id: string) {
    return this.cards.get(id);
  }

  // Answer a Needs-you card (durable on-card HITL) — records the reply and hands it back to its lane.
  @Post('cards/:id/answer')
  answer(@Param('id') id: string, @Body() body: { answer?: string }) {
    return this.cards.answer(id, (body?.answer ?? '').toString());
  }

  @Patch('cards/:id')
  update(@Param('id') id: string, @Body() body: any) {
    return this.cards.update(id, body || {});
  }

  @Delete('cards/:id')
  remove(@Param('id') id: string) {
    return this.cards.remove(id);
  }
}
