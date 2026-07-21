import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { EmoCardsService, EmoLane, EmoStatus } from './emo-cards.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCaptureService } from './emo-capture.service';
import { EmoSearchService } from './emo-search.service';
import { EmoTaskService } from './emo-task.service';
import { EmoReminderService } from './emo-reminder.service';
import { EmoStoryService } from './emo-story.service';
import { EmoCloseService } from './emo-close.service';
import { EmoBriefService } from './emo-brief.service';
import { EmoResearchService } from './emo-research.service';
import { EmoAskService, AskTurn } from './emo-ask.service';
import { EmoTalkService } from './emo-talk.service';
import { EmoSettingsService, EmoSettings } from './emo-settings.service';
import { EmoDeviceService } from './emo-device.service';
import { NotesService } from '../notes/notes.service';

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
    private readonly talkSvc: EmoTalkService,
    private readonly settingsSvc: EmoSettingsService,
    private readonly deviceSvc: EmoDeviceService,
    private readonly notesSvc: NotesService,
    private readonly closeLane: EmoCloseService, // last on purpose: keeps positional wiring stable
    private readonly briefLane: EmoBriefService,
  ) {}

  // Shared EMO settings (BEA-908) — same source of truth for web + app.
  @Get('settings')
  getSettings() {
    return this.settingsSvc.get();
  }
  @Put('settings')
  putSettings(@Body() body: Partial<EmoSettings>) {
    return this.settingsSvc.set(body || {});
  }

  // Interactive voice Ask (EMO Ask): ONE turn — answer straight away + file a Search card (BEA-1012).
  @Post('ask')
  ask(@Body() body: { question?: string; history?: AskTurn[]; sessionContext?: string; web?: 'on' | 'off' | 'auto' }) {
    return this.askSvc.ask({ question: (body?.question || '').toString(), history: Array.isArray(body?.history) ? body!.history! : [], sessionContext: (body?.sessionContext || '').toString(), web: body?.web });
  }

  // The follow-up "want me to do X?" offer, fetched WHILE the voice speaks so it costs no wait (BEA-1012).
  @Post('ask/offer')
  askOffer(@Body() body: { cardId?: string }) {
    return this.askSvc.offerFor((body?.cardId || '').toString());
  }

  // EMO Talk (BEA-905): a multi-turn conversation on Haiku, saved as ONE card per conversation.
  @Post('talk')
  talk(@Body() body: { message?: string; conversationId?: string; web?: 'on' | 'off' | 'auto' }) {
    return this.talkSvc.talk({ message: (body?.message || '').toString(), conversationId: body?.conversationId, web: body?.web });
  }

  // Story lane (EMO 5): append today's captures into the Day Story (user-initiated; never closes the day).
  @Post('story/merge')
  mergeStory() {
    return this.story.mergeToday();
  }

  // Story lane (BEA-985): the per-card "Add to story" button — one capture into its day's story.
  @Post('cards/:id/add-to-story')
  addToStory(@Param('id') id: string) {
    return this.story.addCard(id);
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

  // EMO hardware (BEA-926): one streamed voice turn — raw 16k mono PCM in, routed reply out.
  // The device streams while recording, so a capture never stops until the user stops it.
  @Post('device/turn')
  async deviceTurn(
    @Req() req: Request,
    @Query('mode') mode?: string,
    @Query('conversationId') conversationId?: string,
    @Query('sr') sr?: string,
    @Query('codec') codec?: string,
    @Query('capped') capped?: string,
  ) {
    const MAX = 60 * 1024 * 1024; // ~30 min at 16 kHz mono
    const chunks: Buffer[] = [];
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      req.on('data', (c: Buffer) => {
        total += c.length;
        if (total > MAX) {
          reject(new BadRequestException('Recording too large'));
          try { req.destroy(); } catch { /* closing */ }
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve());
      req.on('error', (e) => reject(e));
    });
    return this.deviceSvc.turn(Buffer.concat(chunks), { mode, conversationId, sampleRate: Number(sr) || 16000, codec, capped: capped === '1' });
  }

  // Save any card as a Note in My Brain (BEA-955). Full detail: body + your words.
  @Post('cards/:id/save-note')
  async saveCardToNote(@Param('id') id: string) {
    const card: any = await this.cards.get(id);
    if (!card) throw new BadRequestException('Card not found');
    const parts: string[] = [];
    if (card.detail) parts.push(String(card.detail));
    else if (card.summary) parts.push(String(card.summary));
    if (card.rawTranscript && card.lane !== 'talk' && card.rawTranscript !== card.detail)
      parts.push(`---\nWhat I said:\n${card.rawTranscript}`);
    const note: any = await this.notesSvc.create({
      title: (card.summary || card.title || 'EMO card').slice(0, 140),
      content: parts.join('\n\n').slice(0, 20000),
      tags: JSON.stringify(['emo', card.lane].filter(Boolean)),
    });
    if (!note) throw new BadRequestException('Nothing to save');
    const links = Array.isArray(card.links) ? card.links : [];
    await this.cards.update(id, { links: [...links, { kind: 'note', id: note.id, label: 'saved to notes' }] }).catch(() => undefined);
    return { ok: true, noteId: note.id };
  }

  // Personal reminders that ring on the device (BEA-944).
  @Get('device/reminders')
  deviceReminders() {
    return this.deviceSvc.listDeviceReminders();
  }
  @Post('device/reminders/:id/ack')
  deviceReminderAck(@Param('id') id: string, @Body() body: { status?: string }) {
    return this.deviceSvc.ackDeviceReminder(id, String(body?.status || 'done'));
  }

  // Listen to what the device recorded for a card (BEA-927).
  @Get('cards/:id/audio')
  async cardAudio(@Param('id') id: string, @Res() res: Response) {
    const card = await this.cards.get(id);
    const buf = (card as any)?.audioPath ? this.deviceSvc.readAudio((card as any).audioPath) : null;
    if (!buf) {
      res.status(404).json({ error: 'No recording kept for this card' });
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  }

  // EMO hardware: speech as 16 kHz mono WAV (the device has no mp3 decoder).
  @Get('device/tts')
  async deviceTts(@Query('text') text: string, @Query('voice') voice: string, @Res() res: Response) {
    const wav = await this.deviceSvc.ttsWav16k(text || '', voice || undefined);
    if (!wav) {
      res.status(400).json({ error: 'TTS unavailable' });
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(wav);
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
    else if (res.ok && res.card?.lane === 'close') void this.closeLane.handle(id).catch(() => undefined); // "which one?" (BEA-1033)
    else if (res.ok && res.card?.lane === 'brief') void this.briefLane.handle(id).catch(() => undefined); // "which person?" (BEA-1032)
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
