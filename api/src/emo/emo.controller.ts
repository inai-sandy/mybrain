import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { EmoCardsService, EmoLane, EmoStatus } from './emo-cards.service';

/** EMO section API (BEA-862) — the card feed reads/acts on cards here. Writes/routing come via EMO 3. */
@Controller('emo')
export class EmoController {
  constructor(private readonly cards: EmoCardsService) {}

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
