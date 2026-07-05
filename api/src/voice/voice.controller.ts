import { BadRequestException, Body, Controller, Get, Post, Put, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { VoiceService } from './voice.service';

@Controller('voice')
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  /** Record-then-transcribe: the in-app mic posts the recorded audio here. */
  @Post('transcribe')
  @UseInterceptors(FileInterceptor('audio'))
  async transcribe(@UploadedFile() file: any) {
    if (!file?.buffer?.length) throw new BadRequestException('No audio received');
    const text = await this.voice.transcribe(file.buffer, file.originalname || 'audio.webm', file.mimetype || 'audio/webm');
    return { text };
  }

  /** Mint a short-lived Deepgram streaming token for the in-app live mic (key stays server-side). */
  @Post('stream-token')
  async streamToken() {
    const t = await this.voice.streamToken();
    return t ? { available: true, ...t } : { available: false };
  }

  /** AI tidy-up for a streamed transcript (punctuation, filler removal). */
  @Post('clean')
  async clean(@Body() body: { text?: string }) {
    return { text: await this.voice.cleanText((body?.text || '').slice(0, 20000)) };
  }

  @Get('config')
  async config() {
    return this.voice.config();
  }

  @Put('engine')
  async setEngine(@Body() body: { engine?: string }) {
    if (!body?.engine) throw new BadRequestException('Pick an engine');
    return this.voice.setEngine(body.engine);
  }

  @Put('cleanup')
  async setCleanup(@Body() body: { cleanup?: boolean }) {
    return this.voice.setCleanup(body?.cleanup !== false);
  }

  @Put('language')
  async setLanguage(@Body() body: { language?: string }) {
    return this.voice.setLanguage(body?.language || '');
  }

  @Put('vocabulary')
  async setVocabulary(@Body() body: { vocabulary?: string }) {
    return this.voice.setVoiceVocabulary(body?.vocabulary || '');
  }

  /** Speak text aloud with OpenAI TTS → mp3 (EMO's voice-out; the device plays the same). */
  @Post('tts')
  async tts(@Body() body: { text?: string; voice?: string }, @Res() res: Response) {
    const audio = await this.voice.tts(body?.text || '', body?.voice);
    if (!audio) {
      res.status(400).json({ error: 'TTS unavailable — add an OpenAI key in Integrations' });
      return;
    }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(audio);
  }

  // --- Deepgram model (live list + current choice) ---
  @Get('deepgram-models')
  async deepgramModels() {
    return { models: await this.voice.deepgramModels() };
  }

  @Get('deepgram-model')
  async getDeepgramModel() {
    return { model: await this.voice.getDeepgramModel() };
  }

  @Put('deepgram-model')
  async setDeepgramModel(@Body() body: { model?: string }) {
    return this.voice.setDeepgramModel(body?.model || '');
  }
}
