import { Injectable, Logger } from '@nestjs/common';
import { VoiceService } from '../voice/voice.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-864/874) — the capture pipeline. A recording is batch-transcribed IN MEMORY (cheap,
 * offline-friendly — NOT the live pipeline) and handed to the intent router, which files the cards.
 * The audio is NOT stored — the transcript is the receipt. If transcription fails, a note card is
 * filed so the moment isn't silently dropped (the owner can retype it).
 */
@Injectable()
export class EmoCaptureService {
  private readonly log = new Logger('EmoCapture');
  constructor(
    private readonly voice: VoiceService,
    private readonly router: EmoRouterService,
    private readonly cards: EmoCardsService,
  ) {}

  async capture(buf: Buffer, filename = 'recording.webm', mime = 'audio/webm', source = 'emo-voice') {
    let transcript = '';
    try { transcript = (await this.voice.transcribe(buf, filename, mime)) || ''; }
    catch (e: any) { this.log.warn(`transcribe failed: ${e?.message || e}`); }

    if (!transcript.trim()) {
      // We don't keep audio, so a failed transcription can't be replayed — file a note to retype it.
      const card = await this.cards.create({ lane: 'note', status: 'needs_you', summary: 'Couldn’t hear that recording', needsQuestion: 'Type what you said, or delete this.', source });
      return { cards: [card], transcript: '' };
    }

    const out = await this.router.route(transcript, { source });
    return { ...out, transcript };
  }
}
