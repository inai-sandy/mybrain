import { BadRequestException, Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpusScript = require('opusscript');
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { VoiceService } from '../voice/voice.service';
import { EmoCardsService } from './emo-cards.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClaimsService } from '../tasks/claims.service';
import { TasksService } from '../tasks/tasks.service';
import { NotesService } from '../notes/notes.service';
import { EmoRouterService } from './emo-router.service';
import { EmoAskService } from './emo-ask.service';
import { EmoTalkService } from './emo-talk.service';

/** IMA ADPCM (4:1) — the one codec the 512 KB no-PSRAM boards can afford (BEA-1595).
 *  Wire format: 256-byte blocks = [int16 LE predictor][uint8 step index][reserved] + 252 bytes
 *  of 4-bit nibbles (low nibble first) -> 505 samples per block, 16 kHz mono. A truncated tail
 *  block decodes as far as it goes; garbage never throws. */
const IMA_STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const IMA_INDEX = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
export const ADPCM_BLOCK = 256;
export function decodeImaAdpcm(buf: Buffer, blockSize = ADPCM_BLOCK): Buffer {
  if (!buf?.length || blockSize < 8) return Buffer.alloc(0);
  const spb = (blockSize - 4) * 2 + 1;
  const blocks = Math.ceil(buf.length / blockSize);
  const out = Buffer.alloc(blocks * spb * 2);
  let o = 0;
  for (let b = 0; b < blocks; b++) {
    const base = b * blockSize;
    if (base + 4 > buf.length) break;
    let pred = buf.readInt16LE(base);
    let idx = Math.min(88, Math.max(0, buf[base + 2]));
    out.writeInt16LE(pred, o); o += 2;
    const end = Math.min(base + blockSize, buf.length);
    for (let i = base + 4; i < end; i++) {
      const byte = buf[i];
      for (const nib of [byte & 0x0f, byte >> 4]) {
        const step = IMA_STEP[idx];
        let diff = step >> 3;
        if (nib & 1) diff += step >> 2;
        if (nib & 2) diff += step >> 1;
        if (nib & 4) diff += step;
        pred += (nib & 8) ? -diff : diff;
        if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
        idx += IMA_INDEX[nib];
        if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
        out.writeInt16LE(pred, o); o += 2;
      }
    }
  }
  return out.subarray(0, o);
}

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

export type DeviceMode = 'capture' | 'ask' | 'story' | 'meeting' | 'research' | 'talk' | 'task' | 'reminder' | 'idea' | 'note' | 'brief' | 'dump';
const MODES: DeviceMode[] = ['capture', 'ask', 'story', 'meeting', 'research', 'talk', 'task', 'reminder', 'idea', 'note', 'brief', 'dump'];

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
 * Keep a device turn inside the firmware's parse buffer. (BEA-1139)
 *
 * The device reads this JSON into a fixed 1600-byte buffer in ONE read, so an oversized body
 * arrives truncated and unparseable — and the firmware then treats a perfectly good 201 as a
 * failure and speaks an error clip. Field caps match what the device stores anyway
 * (heard[160]/reply[512]/say[512]); the byte-budget loop is the hard guarantee, because
 * bullets ("•") and other non-ASCII cost 3 bytes each and character counts alone can lie.
 */
export const DEVICE_BODY_BUDGET = 1200; // bytes; the device's buffer is 1600 — leave real headroom

/**
 * Truncate to a BYTE budget, never a character count. The device's limit is a byte buffer and
 * non-ASCII costs up to 3 bytes per character (a Hindi answer, an emoji, even the "•" bullets we
 * send), so character caps let an oversized body straight through. Iterating by code point also
 * guarantees we never split a character in half and hand the device invalid UTF-8.
 */
function cutBytes(s: string | undefined, maxBytes: number): string | undefined {
  if (typeof s !== 'string' || Buffer.byteLength(s) <= maxBytes) return s;
  const ELL = '…';
  const room = Math.max(0, maxBytes - Buffer.byteLength(ELL));
  let end = 0;
  let used = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (used + b > room) break;
    used += b;
    end += ch.length;
  }
  return `${s.slice(0, end).trimEnd()}${ELL}`;
}

export function clampForDevice(t: DeviceTurn): DeviceTurn {
  const out: DeviceTurn = {
    ...t,
    heard: cutBytes(t.heard, 150) as string,
    reply: cutBytes(t.reply, 480) as string,
    say: cutBytes(t.say, 480) as string,
  };
  // Hard guarantee: shrink whichever field is currently biggest until the serialised body fits.
  // Shrinking only `reply` was not enough — ask/talk put a long unbounded answer in `say`.
  const FIELDS: ('reply' | 'say' | 'heard')[] = ['reply', 'say', 'heard'];
  for (let guard = 0; guard < 64 && Buffer.byteLength(JSON.stringify(out)) > DEVICE_BODY_BUDGET; guard++) {
    let biggest: 'reply' | 'say' | 'heard' | null = null;
    let biggestBytes = 0;
    for (const f of FIELDS) {
      const b = Buffer.byteLength(String(out[f] || ''));
      if (b > biggestBytes) { biggestBytes = b; biggest = f; }
    }
    if (!biggest || biggestBytes <= 24) break; // nothing meaningful left to give back
    out[biggest] = cutBytes(String(out[biggest]), Math.floor(biggestBytes * 0.75)) as string;
  }
  return out;
}

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
    private readonly cardsSvc: EmoCardsService, // failure cards for the fast-ack pipeline (BEA-1593)
  ) {}

  /** Every agent with a task, three fields only — the device draws one row at a time. (BEA-1590)
   *  Not filtered on `enabled`: that flag is the SCHEDULE switch, and hand-run agents live with it
   *  off. The app's Run button ignores it too. (BEA-1591)
   *  Named like the app: the agent's CARD (AgentArea) name, which is what the owner recognises —
   *  builder-made agents carry their first sentence as `Agent.name`. A card holding several jobs
   *  ("Research Agent" × 4) shows each job's own name so rows stay distinct. (BEA-1592) */
  async listAgentsForDevice(): Promise<{ id: string; name: string; color: string | null }[]> {
    const rows = await this.prisma.agent.findMany({
      where: { AND: [{ prompt: { not: null } }, { prompt: { not: '' } }] },   /* has a task; never lists what run would refuse */
      select: { id: true, name: true, color: true, areaId: true },
    });
    const areaIds = Array.from(new Set(rows.map((r: any) => r.areaId).filter(Boolean)));
    let areas: { id: string; name: string; color: string | null }[] = [];
    if (areaIds.length) {
      try { areas = await this.prisma.agentArea.findMany({ where: { id: { in: areaIds } }, select: { id: true, name: true, color: true } }); }
      catch { areas = []; }                                   /* a lookup failure never breaks the device feed */
    }
    const areaById = new Map<string, any>(areas.map((a) => [a.id, a]));
    const perArea = new Map<string, number>();
    for (const r of rows as any[]) if (r.areaId) perArea.set(r.areaId, (perArea.get(r.areaId) || 0) + 1);
    const out = (rows as any[]).map((r) => {
      const area = r.areaId ? areaById.get(r.areaId) : null;
      const shared = r.areaId ? (perArea.get(r.areaId) || 0) > 1 : false;
      const name = area && !shared ? area.name : r.name;
      return { id: r.id, name: String(name || r.name || '').slice(0, 40), color: r.color || area?.color || null };
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

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
    const [rems, claims, cards] = await Promise.all([
      this.prisma.emoDeviceReminder.findMany({ where: { status: 'active', dueAt: { lte: until } }, orderBy: { dueAt: 'asc' }, take: 12 }),
      this.prisma.taskClaim.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        take: 12,
        include: { contact: { select: { name: true } }, task: { select: { title: true } } },
      }),
      // agent questions (durable needs-you HITL): the INPUT section's reason to exist (BEA-1594)
      this.prisma.emoCard.findMany({
        where: { status: 'needs_you' },
        orderBy: { createdAt: 'asc' },
        take: 12,
        select: { id: true, summary: true, title: true, needsQuestion: true, needsOptions: true, createdAt: true },
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

    // Questions carry their options so one keypress can answer (additive fields: old firmware
    // reads id/text/dueAt/kind and ignores the rest — the BEA-1035 widening rule).
    const questions = cards.map((c: any) => {
      let options: string[] = [];
      try { const v = JSON.parse(c.needsOptions || '[]'); if (Array.isArray(v)) options = v; } catch { /* stays empty */ }
      return {
        id: `card:${c.id}`,
        text: String(c.needsQuestion || c.summary || c.title || 'An agent needs you.').slice(0, 155),
        dueAt: new Date(c.createdAt).getTime(),
        kind: 'question',
        options: options.slice(0, 4).map((o) => String(o).slice(0, 60)),
        about: String(c.summary || c.title || '').slice(0, 80),
      };
    });
    // Fixed 12 slots, but the needs-you kinds are the feature: cap reminders so confirms and
    // questions always fit (reminders keep at least 4 slots; needs-you kinds at most 8).
    const needsItems = [...confirms, ...questions].slice(0, 8);
    const remCap = 12 - needsItems.length;
    return { reminders: [...reminders.slice(0, remCap), ...needsItems], needsYou: confirms.length + questions.length };
  }

  /**
   * The device answered. Reminders keep their original done/missed. A confirmation accepts
   * confirm/reject (and treats the old "done"/"missed" words the same way, so a device that has
   * not been updated still does the right thing). (BEA-1035)
   */
  async ackDeviceReminder(id: string, status: string): Promise<{ ok: boolean }> {
    const raw = String(status || '').toLowerCase();
    if (id.startsWith('card:')) {
      // the payload IS the owner's answer (an option label, typed text — voice goes via turn?answerTo)
      if (raw === 'missed') return { ok: true };   /* a timeout is not an answer (BEA-1036 rule) */
      const r: any = await this.cardsSvc.answer(id.slice('card:'.length), String(status || '')).catch(() => ({ ok: false }));
      return { ok: !!r?.ok };
    }
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

  /**
   * One device turn, with the response trimmed to what the hardware can actually swallow.
   *
   * BEA-1139: the firmware parses this JSON out of a fixed `char body[1600]` filled by ONE
   * read (EMO_Net/emo_turn.c parse_turn_response) — no loop, no Content-Length. A longer body
   * arrives truncated, cJSON_Parse fails, the result struct stays zeroed, and the device then
   * SPEAKS an error clip ("I missed that.") even though the capture landed with HTTP 201.
   * Long modes always tripped it: story and dump are exempt from the 3-minute recording cap,
   * so their transcripts run to thousands of characters.
   *
   * Trimming costs nothing: the device only ever keeps heard[160]/reply[512]/say[512]
   * (emo_turn.h), so everything past that was discarded on arrival anyway.
   */
  async turn(body: Buffer, opts: { mode?: string; conversationId?: string; sampleRate?: number; codec?: string; capped?: boolean; answerTo?: string } = {}): Promise<DeviceTurn> {
    // Fast-ack (BEA-1593): every lane except ask/talk is record-first on the devices — they
    // discard the reply and sync in the background. Take custody (durable file) and confirm
    // NOW; transcribe + route async. Cuts the device's upload wait roughly in half and keeps
    // long recordings inside the device's 30 s response timeout.
    const mode: DeviceMode = MODES.includes(opts.mode as DeviceMode) ? (opts.mode as DeviceMode) : 'capture';
    // EMO_FASTACK=0 is the ops kill-switch: everything back through the synchronous path.
    if (mode !== 'ask' && mode !== 'talk' && process.env.EMO_FASTACK !== '0') {
      const fast = await this.turnDeferred(body, opts, mode);
      if (fast) return clampForDevice(fast);
    }
    return clampForDevice(await this.turnInner(body, opts));
  }

  /** How long to wait between transcription retries (tests shrink this). */
  retryDelayMs = 30_000;

  /** "card:<uuid>" -> uuid, or null. Only card answers are supported — and only a clean id
   *  ever reaches a filename. */
  private answerTarget(answerTo?: string): string | null {
    const m = /^card:([0-9a-f-]{8,40})$/.exec(String(answerTo || ''));
    return m ? m[1] : null;
  }

  private pendingDir(): string {
    return process.env.EMO_PENDING_DIR || '/app/data/emo/pending';
  }

  /** Store-then-process: write the WAV durably, answer instantly, work in the background.
   *  Returns null when custody could not be taken — the caller falls back to the sync path.
   *  CUSTODY RULE: the device deletes its SD copy on any 2xx, so the file MUST be safely on
   *  disk (atomic .part + rename) before we confirm. */
  private async turnDeferred(body: Buffer, opts: { sampleRate?: number; codec?: string; capped?: boolean; answerTo?: string }, mode: DeviceMode): Promise<DeviceTurn | null> {
    try {
      if (!body?.length) return null;
      const sr = opts.sampleRate && opts.sampleRate >= 8000 && opts.sampleRate <= 48000 ? opts.sampleRate : 16000;
      let pcm = opts.codec === 'opus' ? decodeOpusStream(body) : opts.codec === 'adpcm' ? decodeImaAdpcm(body) : body;
      if (!pcm.length) return null;
      pcm = normalizePcm(pcm);
      const wav = wavWrap(pcm, sr);
      const dir = this.pendingDir();
      fs.mkdirSync(dir, { recursive: true });
      // the filename IS the job description — a restart re-reads everything it needs from it.
      // The random part makes it collision-proof: two devices in the same millisecond must
      // never overwrite each other's already-acked audio (review finding).
      const ans = this.answerTarget(opts.answerTo);
      const name = `pend-${Date.now()}-${randomUUID().slice(0, 8)}-${mode}${opts.capped ? '-capped' : ''}${ans ? `-ans_${ans}` : ''}.wav`;
      const part = path.join(dir, name + '.part');
      // async writes: a meeting WAV can be tens of MB — never block the event loop for it.
      // Custody holds: the 2xx only goes out after the awaited rename lands.
      await fs.promises.writeFile(part, wav);
      await fs.promises.rename(part, path.join(dir, name));
      setImmediate(() => { this.processPending(name).catch((e) => console.error('[emo] pending failed', name, e)); });
      return { ok: true, mode, heard: '', reply: 'Saved. Working on it in the background.', say: '' };
    } catch (e) {
      console.error('[emo] fast-ack unavailable, sync fallback', e);
      return null;
    }
  }

  /** Transcribe + route one pending file. Deletes it on success; on permanent failure the
   *  audio moves to pending/failed/ and a card says so — a recording never silently vanishes. */
  private async processPending(name: string): Promise<void> {
    const dir = this.pendingDir();
    const p = path.join(dir, path.basename(name));
    const m = /^pend-\d+-[0-9a-f]+-([a-z]+)(-capped)?(?:-ans_([0-9a-f-]+))?\.wav$/.exec(path.basename(name));
    if (!m) return;
    const mode: DeviceMode = MODES.includes(m[1] as DeviceMode) ? (m[1] as DeviceMode) : 'capture';
    const capped = !!m[2];
    const ansCard = m[3] || null;
    let wav: Buffer;
    try { wav = fs.readFileSync(p); } catch (e: any) {
      if (e?.code !== 'ENOENT') console.error('[emo] pending read failed', name, e);
      return;
    }
    let audioPath: string | undefined;
    if (wav.length <= 15 * 1024 * 1024) {
      try { audioPath = this.saveRecording(wav); } catch { /* keep going without audio */ }
    }
    let heard = '';
    let lastErr: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        heard = mode === 'meeting'
          ? (await this.voice.transcribeMeeting(wav, 'audio/wav')).trim()
          : (await this.voice.transcribeWith('deepgram', wav, 'device-turn.wav', 'audio/wav')).trim();
        lastErr = undefined;
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, this.retryDelayMs * (i + 1)));
      }
    }
    if (lastErr) {
      const failedDir = path.join(dir, 'failed');
      try {
        fs.mkdirSync(failedDir, { recursive: true });
        fs.renameSync(p, path.join(failedDir, path.basename(name)));
      } catch { /* the pending file stays for the next sweep */ }
      await this.cardsSvc.create({
        lane: 'note', status: 'done', source: 'emo-device',
        title: 'Recording kept — transcription failed',
        summary: 'A device recording could not be transcribed after 3 tries. The audio is kept on the server.',
        detail: audioPath ? `Audio: ${audioPath}` : `Kept as: pending/failed/${path.basename(name)}`,
      } as any).catch((e) => console.error('[emo] failure card', e));
      return;
    }
    if (heard && ansCard) {
      // a spoken INPUT answer: the words go to the waiting card, not the general router (BEA-1594)
      let ok = false;
      try { const r: any = await this.cardsSvc.answer(ansCard, heard); ok = !!r?.ok; } catch { ok = false; }
      if (!ok) {
        // the card was answered/closed/deleted meanwhile — the owner's words must not vanish
        await this.cardsSvc.create({
          lane: 'note', status: 'done', source: 'emo-device',
          title: 'Answer could not be delivered',
          summary: `You said: "${heard.slice(0, 120)}" — but that question was no longer waiting.`,
          detail: audioPath ? `Audio: ${audioPath}` : undefined,
        } as any).catch((e) => console.error('[emo] answer-failed card', e));
      }
    } else if (heard) await this.routeHeard(mode, heard, { capped }, audioPath);
    else {
      // silence is still an event the owner should see — the old sync path said
      // "couldn't hear anything" live; deferred lanes never read the reply (review finding)
      await this.cardsSvc.create({
        lane: 'note', status: 'done', source: 'emo-device',
        title: 'Nothing heard',
        summary: 'A device recording reached the server but contained no speech.',
        detail: audioPath ? `Audio: ${audioPath}` : undefined,
      } as any).catch((e) => console.error('[emo] silence card', e));
    }
    try { fs.unlinkSync(p); } catch { /* already gone */ }
  }

  /** Restart custody: whatever fast-ack accepted but never finished gets processed again. */
  onModuleInit(): void {
    setImmediate(async () => {
      let files: string[] = [];
      try {
        const all = fs.readdirSync(this.pendingDir());
        for (const f of all.filter((x) => x.endsWith('.part'))) {
          // died mid-write: the device never got a 2xx for this one, so it kept its own copy
          try { fs.unlinkSync(path.join(this.pendingDir(), f)); } catch { /* next boot */ }
        }
        files = all.filter((f) => /^pend-.*\.wav$/.test(f));
      } catch { return; }
      for (const f of files) {
        try { await this.processPending(f); } catch (e) { console.error('[emo] pending sweep', f, e); }
      }
      if (files.length) console.log(`[emo] pending sweep: ${files.length} recording(s) recovered`);
    });
  }

  private async turnInner(body: Buffer, opts: { mode?: string; conversationId?: string; sampleRate?: number; codec?: string; capped?: boolean; answerTo?: string } = {}): Promise<DeviceTurn> {
    if (!body?.length) throw new BadRequestException('No audio received');
    const mode: DeviceMode = MODES.includes(opts.mode as DeviceMode) ? (opts.mode as DeviceMode) : 'capture';
    const sr = opts.sampleRate && opts.sampleRate >= 8000 && opts.sampleRate <= 48000 ? opts.sampleRate : 16000;
    let pcm = opts.codec === 'opus' ? decodeOpusStream(body) : opts.codec === 'adpcm' ? decodeImaAdpcm(body) : body;
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

    const ansCard = this.answerTarget(opts.answerTo);
    if (ansCard) {
      const r: any = await this.cardsSvc.answer(ansCard, heard).catch(() => ({ ok: false }));
      return { ok: !!r?.ok, mode, heard, reply: r?.ok ? 'Answered.' : 'That card is not waiting anymore.', say: '' };
    }
    return this.routeHeard(mode, heard, opts, audioPath);
  }

  /** Everything after transcription: route one heard utterance per mode. Shared by the live
   *  (ask/talk) path and the deferred fast-ack pipeline (BEA-1593). */
  private async routeHeard(mode: DeviceMode, heard: string, opts: { conversationId?: string; capped?: boolean } = {}, audioPath?: string): Promise<DeviceTurn> {
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

    if (mode === 'dump') {
      // Morning brain-dump (BEA-1116): the SAME pipeline as the app and Telegram /dump —
      // tasks.dump() LLM-splits the ramble into today's tasks, stores the BrainDump row and
      // indexes each task. Deliberately NOT the intent router: routing a dump generically
      // scatters one morning into mixed lanes instead of a day's task list.
      // V1 is capture + count: a clarifying question is still recorded server-side, but the
      // device does not round-trip on it.
      const d = await this.tasks.dump(heard, 'emo-device');
      const n = d?.tasks?.length || 0;
      const reply = n
        ? d.tasks.map((t: any) => `• ${t.title || ''}`).join('\n')
        : (d?.question || 'Nothing captured.');
      const say = n === 0
        ? (d?.question || 'Hmm, nothing captured. Try again.')
        : n === 1 ? 'Got it. One task for today.' : `Got it — ${n} tasks for today.`;
      return { ok: true, mode, heard, reply, say };
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
