import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { createReadStream } from 'fs';
import { EmoCardsService, EmoLane, EmoStatus } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCaptureService } from './emo-capture.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';

/** EMO section API — feed, transcript router, capture upload, and lane dispatch on answer. */
@Controller('emo')
export class EmoController {
  constructor(
    private readonly cards: EmoCardsService,
    private readonly router: EmoRouterService,
    private readonly capture_: EmoCaptureService,
    private readonly search: EmoSearchService,
    private readonly taskLane: EmoTaskService,
  ) {}

  // The seam for a transcript already in hand (e.g. the device, or tests): transcript → cards.
  @Post('capture')
  capture(@Body() body: { transcript?: string; source?: string; audioPath?: string }) {
    const transcript = (body?.transcript ?? '').toString().trim();
    if (!transcript) throw new BadRequestException('transcript is required');
    return this.router.route(transcript, { source: body?.source, audioPath: body?.audioPath });
  }

  // Browser capture (EMO 4): upload a recording → save + batch-transcribe → router → cards.
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file: any) {
    if (!file?.buffer?.length) throw new BadRequestException('No recording uploaded');
    return this.capture_.capture(file.buffer, file.originalname || 'recording.webm', file.mimetype || 'audio/webm', 'emo-voice');
  }

  // Stream a card's stored recording (the receipt) for playback.
  @Get('cards/:id/audio')
  async audio(@Param('id') id: string, @Res() res: Response) {
    const found = await this.capture_.audioFor(id);
    if (!found) throw new NotFoundException('No recording for this card');
    res.setHeader('Content-Type', 'audio/webm');
    createReadStream(found.path).on('error', () => res.status(404).end()).pipe(res);
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
  async answer(@Param('id') id: string, @Body() body: { answer?: string }) {
    const res = await this.cards.answer(id, (body?.answer ?? '').toString());
    // The answer completes the clarify → hand the card back to its lane.
    if (res.ok && res.card?.lane === 'search') void this.search.run(id).catch(() => undefined);
    else if (res.ok && res.card?.lane === 'task') void this.taskLane.handle(id).catch(() => undefined);
    return res;
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
