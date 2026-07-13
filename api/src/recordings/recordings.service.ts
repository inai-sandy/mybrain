import { Injectable, NotFoundException, BadRequestException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VoiceService } from '../voice/voice.service';
import { decodeOpusStream, normalizePcm, wavWrap } from '../emo/emo-device.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Recordings (BEA-973) — long ambient sessions (the user's 3–4h meeting days) stored WITHOUT
 * transcription. The device streams 10-minute opus chunks; a tap creates a mark whose trailing
 * window is the ONLY thing transcribed. Anything else can be transcribed later on demand.
 * Chunks stay in the device's raw packet format on disk (no re-encode, no giant WAVs).
 */

const PKT_SECONDS = 0.06; // one opus packet = 60ms, the device's fixed frame

/** Count packets in a length-prefixed opus stream → exact seconds of audio. */
export function scanOpusSeconds(buf: Buffer): { packets: number; seconds: number } {
  let off = 0;
  let packets = 0;
  while (off + 2 <= buf.length) {
    const len = buf.readUInt16LE(off);
    off += 2;
    if (!len || off + len > buf.length) break;
    packets++;
    off += len;
  }
  return { packets, seconds: Math.round(packets * PKT_SECONDS) };
}

/** Slice packets [fromPkt, toPkt) out of a stream — each slice stays independently decodable. */
export function sliceOpusPackets(buf: Buffer, fromPkt: number, toPkt: number): Buffer {
  const parts: Buffer[] = [];
  let off = 0;
  let i = 0;
  while (off + 2 <= buf.length && i < toPkt) {
    const len = buf.readUInt16LE(off);
    if (!len || off + 2 + len > buf.length) break;
    if (i >= fromPkt) parts.push(buf.subarray(off, off + 2 + len));
    off += 2 + len;
    i++;
  }
  return Buffer.concat(parts);
}

@Injectable()
export class RecordingsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly voice: VoiceService,
  ) {}

  onModuleInit() {
    // 90-day VPS retention (BEA-976): old sessions lose their local audio files and flip to
    // 'archived' — rows, marks and transcripts stay; the home server keeps the audio forever.
    setInterval(() => this.retentionTick().catch(() => undefined), 3600_000);
  }

  async retentionTick(): Promise<void> {
    const cutoff = new Date(Date.now() - 90 * 86_400_000);
    const old = await this.prisma.recording.findMany({
      where: { status: 'done', startedAt: { lt: cutoff } },
      select: { id: true },
    });
    for (const r of old) {
      fs.rmSync(path.join(this.dir(), r.id), { recursive: true, force: true });
      await this.prisma.recording.update({ where: { id: r.id }, data: { status: 'archived' } });
    }
  }

  private dir(): string {
    return process.env.RECORDINGS_DIR || '/app/data/recordings';
  }

  private dayKey(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  }

  private hhmmIST(d: Date): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }).format(d);
  }

  /** Device: begin a session. The device's wall clock is trusted within 10 minutes. */
  async start(startedAtMs?: number) {
    const now = Date.now();
    const claimed = Number(startedAtMs) || now;
    const startedAt = Math.abs(claimed - now) > 10 * 60_000 ? new Date(now) : new Date(claimed);
    const rec = await this.prisma.recording.create({
      data: { startedAt, day: this.dayKey(startedAt) },
    });
    return { id: rec.id };
  }

  /** Device: one ~10-minute chunk of raw opus packets. Never transcodes, never transcribes. */
  async addChunk(recId: string, seq: number, body: Buffer) {
    if (!body?.length) throw new BadRequestException('Empty chunk');
    const rec = await this.prisma.recording.findUnique({ where: { id: recId }, include: { chunks: true } });
    if (!rec) throw new NotFoundException('Recording not found');
    const { seconds } = scanOpusSeconds(body);
    const startSec = rec.chunks.reduce((s, c) => s + c.seconds, 0);
    const dir = path.join(this.dir(), recId);
    fs.mkdirSync(dir, { recursive: true });
    const rel = path.join(recId, `chunk-${seq}.opus`);
    fs.writeFileSync(path.join(this.dir(), rel), body);
    await this.prisma.recordingChunk.upsert({
      where: { recordingId_seq: { recordingId: recId, seq } },
      create: { recordingId: recId, seq, seconds, bytes: body.length, path: rel, startSec },
      update: { seconds, bytes: body.length, path: rel },
    });
    await this.prisma.recording.update({
      where: { id: recId },
      data: { seconds: startSec + seconds, bytes: rec.bytes + body.length },
    });
    this.processPendingMarks(recId).catch(() => undefined); // marks resolve as audio arrives
    return { ok: true, seconds, startSec };
  }

  /** Device: a tap. wallTime = session start + offset — the moment the words were SPOKEN. */
  async addMark(recId: string, atSeconds: number, windowSec = 120, kind: 'tap' | 'manual' = 'tap') {
    const rec = await this.prisma.recording.findUnique({ where: { id: recId } });
    if (!rec) throw new NotFoundException('Recording not found');
    const at = Math.max(1, Math.floor(atSeconds));
    const mark = await this.prisma.recordingMark.create({
      data: {
        recordingId: recId,
        atSeconds: at,
        windowSec: Math.max(5, Math.min(3600, Math.floor(windowSec))),
        kind,
        wallTime: new Date(rec.startedAt.getTime() + at * 1000),
      },
    });
    this.processPendingMarks(recId).catch(() => undefined);
    return { id: mark.id };
  }

  /** Device: session over. Title becomes the human span: "Mon 14 Jul, 10:12–13:47". */
  async end(recId: string) {
    const rec = await this.prisma.recording.findUnique({ where: { id: recId } });
    if (!rec) throw new NotFoundException('Recording not found');
    const endedAt = new Date(rec.startedAt.getTime() + rec.seconds * 1000);
    const dayName = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(rec.startedAt);
    const title = `${dayName}, ${this.hhmmIST(rec.startedAt)}–${this.hhmmIST(endedAt)}`;
    await this.prisma.recording.update({ where: { id: recId }, data: { status: 'done', endedAt, title } });
    await this.processPendingMarks(recId).catch(() => undefined);
    return { ok: true, title };
  }

  /** Extract PCM for [fromSec, toSec) across chunk files. */
  private async extractPcm(recId: string, fromSec: number, toSec: number): Promise<Buffer> {
    const chunks = await this.prisma.recordingChunk.findMany({ where: { recordingId: recId }, orderBy: { seq: 'asc' } });
    const parts: Buffer[] = [];
    for (const c of chunks) {
      const cFrom = c.startSec;
      const cTo = c.startSec + c.seconds;
      if (cTo <= fromSec || cFrom >= toSec) continue;
      const buf = fs.readFileSync(path.join(this.dir(), c.path));
      const fromPkt = Math.max(0, Math.floor((fromSec - cFrom) / PKT_SECONDS));
      const toPkt = Math.ceil((Math.min(toSec, cTo) - cFrom) / PKT_SECONDS);
      parts.push(decodeOpusStream(sliceOpusPackets(buf, fromPkt, toPkt)));
    }
    return Buffer.concat(parts);
  }

  /** Transcribe every pending mark whose audio window has fully arrived. */
  async processPendingMarks(recId: string) {
    const rec = await this.prisma.recording.findUnique({ where: { id: recId } });
    if (!rec) return;
    const pending = await this.prisma.recordingMark.findMany({ where: { recordingId: recId, status: 'pending' } });
    for (const m of pending) {
      const covered = rec.seconds >= m.atSeconds || rec.status !== 'recording';
      if (!covered) continue;
      const to = Math.min(m.atSeconds, rec.seconds);
      const from = Math.max(0, to - m.windowSec);
      try {
        const pcm = await this.extractPcm(recId, from, to);
        if (!pcm.length) throw new Error('no audio in window');
        const wav = wavWrap(normalizePcm(pcm));
        const text = (await this.voice.transcribeWith('deepgram', wav, 'mark.wav', 'audio/wav')).trim();
        await this.prisma.recordingMark.update({ where: { id: m.id }, data: { status: 'done', transcript: text || '(nothing heard)' } });
      } catch {
        await this.prisma.recordingMark.update({ where: { id: m.id }, data: { status: 'failed' } });
      }
    }
  }

  /** Web: transcribe an arbitrary stretch on demand — a manual mark, billed only for this range. */
  async transcribeRange(recId: string, fromSec: number, toSec: number) {
    const from = Math.max(0, Math.floor(fromSec));
    const to = Math.floor(toSec);
    if (!(to > from)) throw new BadRequestException('Bad range');
    if (to - from > 3600) throw new BadRequestException('Pick a range under 60 minutes');
    const { id } = await this.addMark(recId, to, to - from, 'manual');
    await this.processPendingMarks(recId);
    return this.prisma.recordingMark.findUnique({ where: { id } });
  }

  /** Web: promote a mark's transcript into the EMO section as a card. */
  async promote(markId: string) {
    const m = await this.prisma.recordingMark.findUnique({ where: { id: markId }, include: { recording: true } });
    if (!m) throw new NotFoundException('Mark not found');
    if (!m.transcript) throw new BadRequestException('Nothing transcribed yet');
    const when = this.hhmmIST(m.wallTime);
    const card = await this.prisma.emoCard.create({
      data: {
        lane: 'meeting',
        status: 'done',
        title: `${m.recording.title || 'Recording'} · ${when}`,
        summary: m.transcript.slice(0, 160),
        detail: m.transcript,
        source: 'recording',
        day: this.dayKey(m.wallTime),
        rawTranscript: m.transcript,
      },
    });
    await this.prisma.recordingMark.update({ where: { id: markId }, data: { cardId: card.id } });
    return { cardId: card.id };
  }

  async list(opts: { q?: string; take?: number; skip?: number } = {}) {
    const where: any = opts.q ? { OR: [{ title: { contains: opts.q } }, { day: { contains: opts.q } }] } : {};
    const take = Math.min(100, Math.max(1, opts.take ?? 30));
    const [rows, total] = await Promise.all([
      this.prisma.recording.findMany({ where, orderBy: { startedAt: 'desc' }, take, skip: Math.max(0, opts.skip ?? 0), include: { _count: { select: { marks: true, chunks: true } } } }),
      this.prisma.recording.count({ where }),
    ]);
    return { recordings: rows, total };
  }

  async get(id: string) {
    const rec = await this.prisma.recording.findUnique({
      where: { id },
      include: { marks: { orderBy: { atSeconds: 'asc' } }, chunks: { orderBy: { seq: 'asc' }, select: { seq: true, seconds: true, startSec: true, bytes: true } } },
    });
    if (!rec) throw new NotFoundException('Recording not found');
    return rec;
  }

  /** Web playback: one chunk decoded to WAV (the player treats a session as a chunk playlist). */
  async chunkWav(recId: string, seq: number): Promise<Buffer> {
    const c = await this.prisma.recordingChunk.findUnique({ where: { recordingId_seq: { recordingId: recId, seq } } });
    if (!c) throw new NotFoundException('Chunk not found');
    const file = path.join(this.dir(), c.path);
    if (!fs.existsSync(file)) throw new NotFoundException('Audio archived — restore from the home server');
    return wavWrap(decodeOpusStream(fs.readFileSync(file)));
  }

  async remove(id: string) {
    const rec = await this.prisma.recording.findUnique({ where: { id } });
    if (!rec) throw new NotFoundException('Recording not found');
    fs.rmSync(path.join(this.dir(), id), { recursive: true, force: true });
    await this.prisma.recording.delete({ where: { id } });
    return { ok: true };
  }
}
