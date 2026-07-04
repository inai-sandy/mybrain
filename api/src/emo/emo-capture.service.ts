import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { VoiceService } from '../voice/voice.service';
import { EmoRouterService } from './emo-router.service';
import { EmoCardsService } from './emo-cards.service';

function audioDir() { return join(process.env.DATA_DIR || '/app/data', 'emo'); }
function extFor(mime: string, filename: string): string {
  if (/webm/.test(mime)) return 'webm';
  if (/ogg/.test(mime)) return 'ogg';
  if (/mp4|m4a|aac/.test(mime)) return 'm4a';
  if (/wav/.test(mime)) return 'wav';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  const m = /\.([a-z0-9]{2,4})$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : 'webm';
}

/**
 * EMO (BEA-864) — the capture pipeline. A recording is saved (the receipt), batch-transcribed
 * (cheap, offline-friendly — NOT the live pipeline), and handed to the intent router which files
 * the cards. If transcription fails the audio is still kept as a note card, so nothing is lost.
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
    const dir = audioDir();
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined);
    const path = join(dir, `${randomUUID()}.${extFor(mime, filename)}`);
    await fs.writeFile(path, buf);

    let transcript = '';
    try { transcript = (await this.voice.transcribe(buf, filename, mime)) || ''; }
    catch (e: any) { this.log.warn(`transcribe failed: ${e?.message || e}`); }

    if (!transcript.trim()) {
      // Keep the recording even if we couldn't read it — nothing is lost.
      const card = await this.cards.create({ lane: 'note', status: 'needs_you', summary: 'Couldn’t transcribe this recording', needsQuestion: 'Type what you said, or delete it.', audioPath: path, source });
      return { cards: [card], transcript: '' };
    }

    const out = await this.router.route(transcript, { audioPath: path, source });
    return { ...out, transcript };
  }

  /** Resolve a card's stored audio file for streaming/playback. */
  async audioFor(cardId: string): Promise<{ path: string } | null> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card?.audioPath) return null;
    return { path: card.audioPath };
  }
}
