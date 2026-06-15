import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { VoiceService } from '../voice/voice.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

function meetingsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'meetings');
}

const VALID_ENGINES = ['deepgram', 'openai', 'elevenlabs', 'gemini'];
const DEFAULT_ENGINE = 'deepgram';

function parseArr(s: string | null): any[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

@Injectable()
export class MeetingsService {
  private readonly logger = new Logger(MeetingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly voice: VoiceService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  // ---- transcription engine (per-meeting choice; default Deepgram for cost) ----

  async getEngine(): Promise<string> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'meetings.engine' } });
    return row?.value && VALID_ENGINES.includes(row.value) ? row.value : DEFAULT_ENGINE;
  }

  async setEngine(engine: string): Promise<{ engine: string }> {
    const e = VALID_ENGINES.includes(engine) ? engine : DEFAULT_ENGINE;
    await this.prisma.setting.upsert({ where: { key: 'meetings.engine' }, create: { key: 'meetings.engine', value: e }, update: { value: e } });
    return { engine: e };
  }

  /** Engines for the picker (which have a key configured), plus the current default. */
  async engineOptions() {
    return { engines: await this.voice.engines(), default: await this.getEngine() };
  }

  /** Transcribe a recorded meeting with the chosen engine, then AI-summarize. Opt-in (never automatic). */
  async transcribe(id: string, engineReq?: string): Promise<any> {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return null;
    if (!m.audioPath) return { error: 'no-audio' };
    const engine = engineReq && VALID_ENGINES.includes(engineReq) ? engineReq : await this.getEngine();
    await this.prisma.meeting.update({ where: { id }, data: { status: 'transcribing', engine } });
    try {
      const buf = await fs.readFile(m.audioPath);
      const transcript = await this.voice.transcribeWith(engine, buf, `${id}.${(m.audioMime || 'webm').includes('webm') ? 'webm' : 'audio'}`, m.audioMime || 'audio/webm');
      if (!transcript) {
        await this.prisma.meeting.update({ where: { id }, data: { status: 'recorded' } });
        return { error: 'transcribe-failed' };
      }
      const ai = await this.summarize(transcript, m.agenda);
      await this.prisma.meeting.update({
        where: { id },
        data: {
          status: 'transcribed',
          transcript,
          summary: ai.summary || null,
          takeaways: JSON.stringify(ai.takeaways || []),
          decisions: JSON.stringify(ai.decisions || []),
          actionItems: JSON.stringify(ai.actionItems || []),
        },
      });
      return this.get(id);
    } catch (e) {
      this.logger.warn(`Meeting transcribe failed (${id}): ${String((e as Error)?.message || e)}`);
      await this.prisma.meeting.update({ where: { id }, data: { status: 'recorded' } }).catch(() => undefined);
      return { error: 'transcribe-failed' };
    }
  }

  /** AI write-up from the transcript: summary + takeaways + decisions + action items (English). */
  private async summarize(transcript: string, agenda?: string | null): Promise<{ summary?: string; takeaways?: string[]; decisions?: string[]; actionItems?: any[] }> {
    const tmpl = await this.prompts.get('meeting.summary');
    const prompt = `${tmpl}\n\n${agenda?.trim() ? `AGENDA / CONTEXT:\n${agenda.trim()}\n\n` : ''}TRANSCRIPT:\n${transcript.slice(0, 100000)}`;
    const text = await this.llm.complete(prompt, 2000, 'meeting-summary');
    if (!text) return { summary: '', takeaways: [], decisions: [], actionItems: [] };
    try {
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      const arr = (v: any) => (Array.isArray(v) ? v : []);
      return {
        summary: String(json.summary || '').trim(),
        takeaways: arr(json.takeaways).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 20),
        decisions: arr(json.decisions).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 20),
        actionItems: arr(json.actionItems).map((x: any) => (typeof x === 'string' ? { title: x } : { title: String(x?.title || '').trim(), owner: x?.owner || null })).filter((a: any) => a.title).slice(0, 30),
      };
    } catch {
      // Fall back to using the raw text as the summary so nothing is lost.
      return { summary: text.trim().slice(0, 4000), takeaways: [], decisions: [], actionItems: [] };
    }
  }

  private shape(m: any) {
    return {
      id: m.id,
      title: m.title,
      agenda: m.agenda,
      durationSec: m.durationSec,
      status: m.status,
      engine: m.engine,
      hasAudio: !!m.audioPath,
      transcript: m.transcript,
      summary: m.summary,
      takeaways: parseArr(m.takeaways),
      decisions: parseArr(m.decisions),
      actionItems: parseArr(m.actionItems),
      language: m.language,
      savedToMemory: m.savedToMemory,
      shared: m.shared,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    };
  }

  /** Create a meeting; if an audio recording is provided, store it on the data volume. */
  async create(data: { title?: string; agenda?: string; durationSec?: number }, audio?: { buffer: Buffer; mime: string }) {
    const m = await this.prisma.meeting.create({
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 200) : undefined,
        agenda: data.agenda?.trim() ? data.agenda.trim().slice(0, 4000) : null,
        durationSec: Number.isFinite(data.durationSec) ? Math.max(0, Math.round(Number(data.durationSec))) : 0,
      },
    });
    if (audio?.buffer?.length) {
      const dir = meetingsDir();
      await fs.mkdir(dir, { recursive: true });
      const ext = audio.mime.includes('webm') ? 'webm' : audio.mime.includes('ogg') ? 'ogg' : audio.mime.includes('mp4') || audio.mime.includes('m4a') ? 'm4a' : audio.mime.includes('wav') ? 'wav' : 'webm';
      const path = join(dir, `${m.id}.${ext}`);
      await fs.writeFile(path, audio.buffer);
      await this.prisma.meeting.update({ where: { id: m.id }, data: { audioPath: path, audioMime: audio.mime } });
    }
    return this.shape(await this.prisma.meeting.findUnique({ where: { id: m.id } }));
  }

  async list(q?: string) {
    const rows = await this.prisma.meeting.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 });
    let list = rows.map((m) => this.shape(m));
    if (q?.trim()) {
      const s = q.toLowerCase();
      list = list.filter((m) => [m.title, m.summary, m.transcript, ...(m.takeaways || [])].filter(Boolean).join(' ').toLowerCase().includes(s));
    }
    return list;
  }

  async get(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    return m ? this.shape(m) : null;
  }

  async update(id: string, data: { title?: string; agenda?: string }) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return null;
    await this.prisma.meeting.update({
      where: { id },
      data: {
        title: data.title?.trim() ? data.title.trim().slice(0, 200) : m.title,
        agenda: data.agenda !== undefined ? (data.agenda?.trim() ? data.agenda.trim().slice(0, 4000) : null) : m.agenda,
      },
    });
    return this.get(id);
  }

  async remove(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return { ok: true };
    if (m.audioPath) await fs.unlink(m.audioPath).catch(() => undefined);
    await this.prisma.meeting.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  async audioFile(id: string): Promise<{ path: string; mime: string } | null> {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m?.audioPath) return null;
    return { path: m.audioPath, mime: m.audioMime || 'audio/webm' };
  }
}
