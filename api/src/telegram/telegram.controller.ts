import { Body, Controller, Get, Headers, HttpCode, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/public.decorator';
import { TelegramService } from './telegram.service';

@Controller('telegram')
export class TelegramController {
  constructor(private readonly telegram: TelegramService) {}

  /** Telegram calls this on every update. Public, but protected by a secret token header. */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Body() body: any, @Headers('x-telegram-bot-api-secret-token') secret: string, @Req() _req: Request) {
    const expected = await this.telegram.webhookSecret();
    if (!secret || secret !== expected) return { ok: false };
    // Ack immediately; process async so a slow LLM call never makes Telegram retry/duplicate.
    void this.telegram.handleUpdate(body);
    return { ok: true };
  }

  /** Register (or re-register) the webhook + command menu with Telegram. */
  @Post('connect')
  async connect() {
    return this.telegram.setup();
  }

  @Get('status')
  async status() {
    return this.telegram.status();
  }

  /** Voice-transcription provider: openai (Whisper) or gemini (OpenRouter). */
  @Get('voice')
  async getVoice() {
    return { provider: await this.telegram.getVoiceProvider() };
  }

  @Put('voice')
  async setVoice(@Body() body: { provider?: string }) {
    return this.telegram.setVoiceProvider(body?.provider || 'openai');
  }

  /** Unlink the owner chat so a fresh /start can re-claim the bot. */
  @Post('disconnect')
  async disconnect() {
    return this.telegram.unlink();
  }
}
