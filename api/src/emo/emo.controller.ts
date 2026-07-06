import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EmoCardsService, EmoLane, EmoStatus } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCaptureService } from './emo-capture.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';
import { EmoReminderService } from './emo-reminder.service';
import { EmoStoryService } from './emo-story.service';
import { EmoResearchService } from './emo-research.service';
import { EmoAskService, AskTurn } from './emo-ask.service';

/** EMO section API — feed, transcript router, capture upload, and lane dispatch on answer. */
@Controller('emo')
export class EmoController {
  constructor(
    private readonly cards: EmoCardsService,
    private readonly router: EmoRouterService,
    private readonly capture_: EmoCaptureService,
    private readonly search: EmoSearchService,
    private readonly taskLane: EmoTaskService,
    private readonly reminderLane: EmoReminderService,
    private readonly story: EmoStoryService,
    private readonly researchLane: EmoResearchService,
    private readonly askSvc: EmoAskService,
  ) {}

  // Interactive voice Ask (EMO Ask): one turn — clarify (>=1) or answer + file a Search card.
  @Post('ask')
  ask(@Body() body: { question?: string; history?: AskTurn[]; sessionContext?: string }) {
    return this.askSvc.ask({ question: (body?.question || '').toString(), history: Array.isArray(body?.history) ? body!.history! : [], sessionContext: (body?.sessionContext || '').toString() });
  }

  // Story lane (EMO 5): append today's captures into the Day Story (user-initiated; never closes the day).
  @Post('story/merge')
  mergeStory() {
    return this.story.mergeToday();
  }

  // Quick Research (EMO 11): "Go deeper" → turn a quick card into a saved deep-research flow.
  @Post('cards/:id/go-deeper')
  async goDeeper(@Param('id') id: string) {
    await this.researchLane.goDeeper(id);
    return this.cards.get(id);
  }

  // The seam for a transcript already in hand (e.g. the device, or tests): transcript → cards.
  @Post('capture')
  capture(@Body() body: { transcript?: string; source?: string; audioPath?: string; lane?: string }) {
    const transcript = (body?.transcript ?? '').toString().trim();
    if (!transcript) throw new BadRequestException('transcript is required');
    // `lane` forces a mode (Meeting/Research from the app) — skips the router's guessing.
    return this.router.route(transcript, { source: body?.source, audioPath: body?.audioPath, lane: body?.lane as any });
  }

  // Browser capture (EMO 4): upload a recording → transcribe in memory → router → cards (audio not kept).
  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } })) // 50 MB cap (BEA-878)
  async upload(@UploadedFile() file: any) {
    if (!file?.buffer?.length) throw new BadRequestException('No recording uploaded');
    if (file.mimetype && !/^audio\//i.test(file.mimetype)) throw new BadRequestException('Upload an audio recording');
    return this.capture_.capture(file.buffer, file.originalname || 'recording.webm', file.mimetype || 'audio/webm', 'emo-voice');
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
    else if (res.ok && res.card?.lane === 'reminder') void this.reminderLane.handle(id).catch(() => undefined);
    else if (res.ok && res.card?.lane === 'research') void this.researchLane.handle(id).catch(() => undefined);
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
