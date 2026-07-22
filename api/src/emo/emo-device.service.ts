import { BadRequestException, Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpusScript = require('opusscript');
import * as fs from 'fs';
import * as path from 'path';
import { VoiceService } from '../voice/voice.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimsService } from '../tasks/claims.service';
import { TasksService } from '../tasks/tasks.service';
import { NotesService } from '../notes/notes.service';
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

export type DeviceMode = 'capture' | 'ask' | 'story' | 'meeting' | 'research' | 'talk' | 'task' | 'reminder' | 'idea' | 'note' | 'brief';
const MODES: DeviceMode[] = ['capture', 'ask', 'story', 'meeting', 'research', 'talk', 'task', 'reminder', 'idea', 'note', 'brief'];

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
    private readonly notes: NotesService,
    private readonly claims: ClaimsService, // last on purpose: keeps positional wiring stable
    private readonly tasks: TasksService,
  ) {}

  /**
   * What is waiting for the owner on the device. (BEA-1035)
   *
   * This started as a reminder feed and is now a "needs you" queue, because the devices ALREADY
   * poll it, render it, ring on it and can answer it — widening what ships beats inventing a new
   * protocol for hardware that is already flashed and in daily use.
   *
   * Every item keeps the exact original shape ({id, text, dueAt}) and simply gains a `kind`. Old
   * firmware ignores the field it does not know and behaves precisely as before, so shipping this
   * cannot break the devices in the owner's hand.
   */
  async listDeviceReminders(): Promise<{ reminders: { id: string; text: string; dueAt: number; kind: string }[]; needsYou: number }> {
    const until = new Date(Date.now() + 48 * 3600 * 1000);
    const [rems, claims] = await Promise.all([
      this.prisma.emoDeviceReminder.findMany({ where: { status: 'active', dueAt: { lte: until } }, orderBy: { dueAt: 'asc' }, take: 12 }),
      this.prisma.taskClaim.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 12,
        include: { contact: { select: { name: true } }, task: { select: { title: true } } },
      }),
    ]);

    const reminders = rems.map((r: any) => ({ id: r.id, text: r.text, dueAt: r.dueAt.getTime(), kind: 'reminder' }));
    // Short enough to read on a small screen — the device holds 160 characters per line.
    const confirms = claims
      .filter((c: any) => c.task)
      .map((c: any) => ({
        id: `claim:${c.id}`,
        text: `${(c.contact?.name || 'Someone').split(/\s+/)[0]} says done: ${c.task.title}`.slice(0, 155),
        dueAt: new Date(c.createdAt).getTime(),
        kind: 'confirm',
      }));

    return { reminders: [...reminders, ...confirms].slice(0, 12), needsYou: confirms.length };
  }

  /**
   * The device answered. Reminders keep their original done/missed. A confirmation accepts
   * confirm/reject (and treats the old "done"/"missed" words the same way, so a device that has
   * not been updated still does the right thing). (BEA-1035)
   */
  async ackDeviceReminder(id: string, status: string): Promise<{ ok: boolean }> {
    const raw = String(status || '').toLowerCase();
    if (id.startsWith('claim:')) {
      const claimId = id.slice('claim:'.length);
      // "missed" is what OLD firmware auto-sends when a ring goes unanswered — it is a timeout,
      // not a human decision. A pendant sitting on a charger must never silently reject someone's
      // claim. Ignore it; the claim stays waiting for a real answer. (BEA-1036 review)
      if (raw === 'missed') return { ok: true };
      const confirm = !(raw === 'reject' || raw === 'no');
      const r = await this.claims.decide(claimId, confirm).catch(() => ({ ok: false }) as any);
      if (r.ok && r.taskId) await this.tasks.setDone(r.taskId, !!r.confirmed);
      return { ok: !!r.ok };
    }
    const st = raw === 'missed' ? 'missed' : 'done';
    await this.prisma.emoDeviceReminder.update({ where: { id }, data: { status: st } }).catch(() => undefined);
    return { ok: true };
  }

  async turn(body: Buffer, opts: { mode?: string; conversationId?: string; sampleRate?: number; codec?: string; capped?: boolean } = {}): Promise<DeviceTurn> {
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
      // ragOnly: device answers come from the local RAG store only, never SuperMemory (BEA-967)
      const r = await this.ask.ask({ question: heard, web: 'auto', direct: true, ragOnly: true });
      if (r.mode === 'clarify') return { ok: true, mode, heard, reply: r.question, say: r.question };
      const s = (r.summary || '').trim() || 'Done.';
      return { ok: true, mode, heard, reply: s, say: s, cardId: r.cardId };
    }

    if (mode === 'talk') {
      // search-first Talk (952): the device always brings fresh web results to the answer
      const r = await this.talk.talk({ message: heard, conversationId: opts.conversationId || undefined, web: 'on', noQuestions: true });
      const s = (r.reply || '').trim() || 'Okay.';
      return { ok: true, mode, heard, reply: s, say: s.slice(0, 600), conversationId: r.conversationId };
    }

    // capture routes freely; story/meeting/research force their lane
    const lane = mode === 'capture' ? undefined : mode;
    const { cards } = await this.router.route(heard, { source: 'emo-device', lane: lane as any, audioPath });
    // NOTE mode creates a REAL Note in My Brain, not just a card (BEA-957)
    if (mode === 'note' && cards?.length) {
      try {
        const note: any = await this.notes.create({
          title: heard.split('\n')[0].slice(0, 80),
          content: heard,
          tags: JSON.stringify(['emo', 'note']),
        });
        if (note?.id) {
          const c0: any = cards[0];
          const links = Array.isArray(c0.links) ? c0.links : [];
          await this.prisma.emoCard.update({ where: { id: c0.id }, data: { links: JSON.stringify([...links, { kind: 'note', id: note.id, label: 'in Notes' }]) } }).catch(() => undefined);
        }
      } catch { /* the card still holds the words */ }
    }
    const n = cards?.length || 0;
    const first = n ? String((cards[0] as any)?.summary || '').trim() : '';
    let reply = n ? cards.map((c: any) => `• ${c.summary || ''}`).join('\n') : 'Nothing captured.';
    let say = n === 0 ? 'Hmm, nothing captured. Try again.' : n === 1 ? `Got it. ${first}` : `Got it — saved ${n} cards.`;
    if (opts.capped) {
      // the device auto-stopped at its 3-minute cap — the cut must never be silent (BEA-971)
      reply += '\n⏱ Recording stopped at the 3-minute limit — only the first 3 minutes were saved.';
      say += ' Heads up — the recording stopped at the three minute limit.';
    }
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
    // TTS comes out quiet next to the loudness-mastered clip pack — normalize it
    // to the same ceiling so spoken answers match the voice pack. (BEA-953)
    return wavWrap(normalizePcm(resample24to16(pcm24)), 16000);
  }
}
