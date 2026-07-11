import { BadRequestException, Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpusScript = require('opusscript');
import * as fs from 'fs';
import * as path from 'path';
import { VoiceService } from '../voice/voice.service';
import { PrismaService } from '../prisma/prisma.service';
import { EmoRouterService } from './emo-router.service';
import { EmoAskService } from './emo-ask.service';
import { EmoTalkService } from './emo-talk.service';

/** Wrap raw 16-bit mono PCM in a minimal WAV container (what the transcriber + device speak). */
export function wavWrap(pcm: Buffer, sampleRate = 16000, channels = 1): Buffer {
  const byteRate = sampleRate * channels * 2;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); // PCM chunk size
  h.writeUInt16LE(1, 20); // PCM format
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(channels * 2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Linear-interpolation resample of 24 kHz 16-bit mono PCM down to 16 kHz (OpenAI TTS → device rate). */
export function resample24to16(pcm24: Buffer): Buffer {
  const inSamples = Math.floor(pcm24.length / 2);
  const outSamples = Math.floor((inSamples * 2) / 3);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const src = i * 1.5;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const s0 = pcm24.readInt16LE(i0 * 2);
    const s1 = i0 + 1 < inSamples ? pcm24.readInt16LE((i0 + 1) * 2) : s0;
    out.writeInt16LE(Math.round(s0 * (1 - frac) + s1 * frac), i * 2);
  }
  return out;
}

/** Length-prefixed raw Opus packets (2-byte LE per frame) -> 16k mono PCM. */
export function decodeOpusStream(body: Buffer): Buffer {
  const opus = new OpusScript(16000, 1, OpusScript.Application.VOIP);
  const parts: Buffer[] = [];
  let off = 0;
  while (off + 2 <= body.length) {
    const len = body.readUInt16LE(off);
    off += 2;
    if (!len || off + len > body.length) break;
    try {
      parts.push(Buffer.from(opus.decode(body.subarray(off, off + len))));
    } catch { /* skip a bad frame rather than losing the turn */ }
    off += len;
  }
  try { opus.delete(); } catch { /* wasm cleanup */ }
  return Buffer.concat(parts);
}

/** Peak-normalize 16-bit PCM toward -3 dBFS (gain capped at 8x) — device mics run quiet. */
export function normalizePcm(pcm: Buffer): Buffer {
  const n = Math.floor(pcm.length / 2);
  let peak = 1;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(pcm.readInt16LE(i * 2));
    if (v > peak) peak = v;
  }
  let gain = (32767 * 0.7) / peak;
  if (gain > 8) gain = 8;
  if (gain <= 1.05) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < n; i++) {
    let v = Math.round(pcm.readInt16LE(i * 2) * gain);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

export type DeviceMode = 'capture' | 'ask' | 'story' | 'meeting' | 'research' | 'talk' | 'task' | 'reminder' | 'idea' | 'note';
const MODES: DeviceMode[] = ['capture', 'ask', 'story', 'meeting', 'research', 'talk', 'task', 'reminder', 'idea', 'note'];

export type DeviceTurn = {
  ok: boolean;
  mode: DeviceMode;
  heard: string;
  reply: string; // shown on the round display
  say: string; // spoken through the speaker
  lane?: string; // first card's lane — the device picks its per-lane voice clip (BEA-930)
  cardId?: string;
  conversationId?: string;
};

/**
 * EMO hardware (BEA-926) — one streamed voice turn from the device:
 * raw PCM in → transcribe → route per mode → short reply text + speakable sentence out.
 */
@Injectable()
export class EmoDeviceService {
  constructor(
    private readonly voice: VoiceService,
    private readonly router: EmoRouterService,
    private readonly ask: EmoAskService,
    private readonly talk: EmoTalkService,
    private readonly prisma: PrismaService,
  ) {}

  /** Personal reminders the device should ring (next 48h, oldest first). */
  async listDeviceReminders(): Promise<{ reminders: { id: string; text: string; dueAt: number }[] }> {
    const until = new Date(Date.now() + 48 * 3600 * 1000);
    const rows = await this.prisma.emoDeviceReminder.findMany({
      where: { status: 'active', dueAt: { lte: until } },
      orderBy: { dueAt: 'asc' },
      take: 20,
    });
    return { reminders: rows.map((r: any) => ({ id: r.id, text: r.text, dueAt: r.dueAt.getTime() })) };
  }

  /** The device rang (done) or gave up (missed). */
  async ackDeviceReminder(id: string, status: string): Promise<{ ok: boolean }> {
    const st = status === 'missed' ? 'missed' : 'done';
    await this.prisma.emoDeviceReminder.update({ where: { id }, data: { status: st } }).catch(() => undefined);
    return { ok: true };
  }

  async turn(body: Buffer, opts: { mode?: string; conversationId?: string; sampleRate?: number; codec?: string } = {}): Promise<DeviceTurn> {
    if (!body?.length) throw new BadRequestException('No audio received');
    const mode: DeviceMode = MODES.includes(opts.mode as DeviceMode) ? (opts.mode as DeviceMode) : 'capture';
    const sr = opts.sampleRate && opts.sampleRate >= 8000 && opts.sampleRate <= 48000 ? opts.sampleRate : 16000;
    let pcm = opts.codec === 'opus' ? decodeOpusStream(body) : body;
    if (!pcm.length) throw new BadRequestException('Could not decode the audio');
    pcm = normalizePcm(pcm);
    const wav = wavWrap(pcm, sr);
    let audioPath: string | undefined;
    // disk guard (941): an hour-long meeting decodes to >100MB of WAV — don't hoard those
    if (wav.length <= 15 * 1024 * 1024) {
      try { audioPath = this.saveRecording(wav); } catch { /* keep the turn alive without audio */ }
    }
    // meetings get speaker labels (Speaker 1/2…) via diarization (941)
    const heard = mode === 'meeting'
      ? (await this.voice.transcribeMeeting(wav, 'audio/wav')).trim()
      : (await this.voice.transcribeWith('deepgram', wav, 'device-turn.wav', 'audio/wav')).trim();
    if (!heard) {
      return { ok: false, mode, heard: '', reply: "I couldn't hear anything.", say: "Sorry, I couldn't hear that. Try again." };
    }

    if (mode === 'ask') {
      // direct: the device never asks counter-questions (938) — best-guess answer immediately
      const r = await this.ask.ask({ question: heard, web: 'auto', direct: true });
      if (r.mode === 'clarify') return { ok: true, mode, heard, reply: r.question, say: r.question };
      const s = (r.summary || '').trim() || 'Done.';
      return { ok: true, mode, heard, reply: s, say: s, cardId: r.cardId };
    }

    if (mode === 'talk') {
      const r = await this.talk.talk({ message: heard, conversationId: opts.conversationId || undefined, web: 'auto', noQuestions: true });
      const s = (r.reply || '').trim() || 'Okay.';
      return { ok: true, mode, heard, reply: s, say: s.slice(0, 600), conversationId: r.conversationId };
    }

    // capture routes freely; story/meeting/research force their lane
    const lane = mode === 'capture' ? undefined : mode;
    const { cards } = await this.router.route(heard, { source: 'emo-device', lane: lane as any, audioPath });
    const n = cards?.length || 0;
    const first = n ? String((cards[0] as any)?.summary || '').trim() : '';
    const reply = n ? cards.map((c: any) => `• ${c.summary || ''}`).join('\n') : 'Nothing captured.';
    const say = n === 0 ? 'Hmm, nothing captured. Try again.' : n === 1 ? `Got it. ${first}` : `Got it — saved ${n} cards.`;
    return { ok: n > 0, mode, heard, reply, say, lane: n ? String((cards[0] as any).lane || '') : undefined, cardId: n ? (cards[0] as any).id : undefined };
  }

  /** Save the device recording so the owner can LISTEN to what EMO heard (BEA-927). Keeps newest 50. */
  private saveRecording(wav: Buffer): string {
    const dir = process.env.EMO_DEVICE_AUDIO_DIR || '/app/data/emo/recordings';
    fs.mkdirSync(dir, { recursive: true });
    const name = `turn-${Date.now()}.wav`;
    fs.writeFileSync(path.join(dir, name), wav);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
    while (files.length > 50) {
      const old = files.shift();
      if (old) fs.unlinkSync(path.join(dir, old));
    }
    return name;
  }

  /** Read a kept recording by its stored name (path-traversal safe). */
  readAudio(name: string): Buffer | null {
    const safe = path.basename(name || '');
    if (!safe.endsWith('.wav')) return null;
    const dir = process.env.EMO_DEVICE_AUDIO_DIR || '/app/data/emo/recordings';
    const p = path.join(dir, safe);
    try { return fs.readFileSync(p); } catch { return null; }
  }

  /** Speech for the device: 16 kHz mono WAV (its codec plays raw PCM — no decoder onboard). */
  async ttsWav16k(text: string, voice?: string): Promise<Buffer | null> {
    const pcm24 = await this.voice.ttsPcm(text, voice);
    if (!pcm24?.length) return null;
    return wavWrap(resample24to16(pcm24), 16000);
  }
}
