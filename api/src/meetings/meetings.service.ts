import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join } from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { looseJsonParse, narrativeField } from '../common/llm-json';
import { VoiceService } from '../voice/voice.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { MemoryService } from '../memory/memory.service';

function meetingsDir() {
  return join(process.env.DATA_DIR || '/app/data', 'meetings');
}

const VALID_ENGINES = ['deepgram', 'openai', 'elevenlabs', 'gemini'];
const DEFAULT_ENGINE = 'deepgram';
// Title the recorder auto-assigns until the AI names the meeting from its content.
const isAutoTitle = (t: string) => /^Meeting · /.test(t) || t === 'Untitled meeting' || !t.trim();

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
    private readonly memory: MemoryService,
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

  // ---- summary model (the LLM that writes the summary/title/tags) ----

  async getModel(): Promise<LlmConfig | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'meetings.llm' } });
    if (!row) return null; // null = use the app default model
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : null;
    } catch {
      return null;
    }
  }

  async setModel(provider: string, model: string): Promise<LlmConfig> {
    const cfg = { provider: provider === 'anthropic' ? 'anthropic' : 'openrouter', model } as LlmConfig;
    await this.prisma.setting.upsert({ where: { key: 'meetings.llm' }, create: { key: 'meetings.llm', value: JSON.stringify(cfg) }, update: { value: JSON.stringify(cfg) } });
    return cfg;
  }

  async listModels() {
    return this.llm.listOpenRouterModels(['openai/', 'anthropic/']);
  }

  /** Transcribe a recorded meeting with the chosen engine, then AI-summarize. Opt-in (never automatic). */
  async transcribe(id: string, engineReq?: string): Promise<any> {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return null;
    if (!m.audioPath) return { error: 'no-audio' };
    if (m.status === 'transcribing') return { error: 'already-transcribing' };
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
          // Rename to the AI title only if the user hasn't given it their own name.
          title: ai.title && isAutoTitle(m.title) ? ai.title : m.title,
          tags: JSON.stringify(ai.tags || []),
          summary: ai.summary || null,
          takeaways: JSON.stringify(ai.takeaways || []),
          decisions: JSON.stringify(ai.decisions || []),
          actionItems: JSON.stringify(ai.actionItems || []),
        },
      });
      // Optionally free the recording — but ONLY when the summary also succeeded. summarize() returns
      // an empty summary on an LLM hiccup (it never throws); deleting the audio then left the meeting
      // permanently without a summary and no way to retry (transcribe needs the audio). (BEA-805)
      const summaryOk = !!(ai.summary && ai.summary.trim());
      if (summaryOk && (await this.getAutoDeleteAudio())) await this.deleteAudio(id);
      return this.get(id);
    } catch (e) {
      this.logger.warn(`Meeting transcribe failed (${id}): ${String((e as Error)?.message || e)}`);
      await this.prisma.meeting.update({ where: { id }, data: { status: 'recorded' } }).catch(() => undefined);
      return { error: 'transcribe-failed' };
    }
  }

  /** AI write-up from the transcript: title + tags + summary + takeaways + decisions + action items (English).
   *  Uses the meeting summary model if set, else the app default. */
  private async summarize(transcript: string, agenda?: string | null): Promise<{ title?: string; tags?: string[]; summary?: string; takeaways?: string[]; decisions?: string[]; actionItems?: any[] }> {
    const tmpl = await this.prompts.get('meeting.summary');
    const prompt = `${tmpl}\n\n${agenda?.trim() ? `AGENDA / CONTEXT:\n${agenda.trim()}\n\n` : ''}TRANSCRIPT:\n${transcript.slice(0, 100000)}`;
    const model = await this.getModel();
    const text = model ? await this.llm.completeWith(model, prompt, 2000, 'meeting-summary') : await this.llm.complete(prompt, 2000, 'meeting-summary');
    if (!text) return { summary: '', takeaways: [], decisions: [], actionItems: [] };
    const json = looseJsonParse(text); // robust — tolerates fences + raw newlines (BEA-884)
    if (json) {
      const arr = (v: any) => (Array.isArray(v) ? v : []);
      return {
        title: String(json.title || '').trim().slice(0, 80) || undefined,
        tags: arr(json.tags).map((x: any) => String(x).toLowerCase().trim()).filter(Boolean).slice(0, 5),
        summary: String(json.summary || '').trim(),
        takeaways: arr(json.takeaways).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 20),
        decisions: arr(json.decisions).map((x: any) => String(x).trim()).filter(Boolean).slice(0, 20),
        actionItems: arr(json.actionItems).map((x: any) => (typeof x === 'string' ? { title: x } : { title: String(x?.title || '').trim(), owner: x?.owner || null })).filter((a: any) => a.title).slice(0, 30),
      };
    }
    // Couldn't parse → keep a READABLE summary, never a raw JSON blob.
    return { summary: narrativeField(text, 'summary').slice(0, 4000), takeaways: [], decisions: [], actionItems: [] };
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
      tags: parseArr(m.tags),
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
      try {
        const dir = meetingsDir();
        await fs.mkdir(dir, { recursive: true });
        const ext = audio.mime.includes('webm') ? 'webm' : audio.mime.includes('ogg') ? 'ogg' : audio.mime.includes('mp4') || audio.mime.includes('m4a') ? 'm4a' : audio.mime.includes('wav') ? 'wav' : 'webm';
        const path = join(dir, `${m.id}.${ext}`);
        await fs.writeFile(path, audio.buffer);
        await this.prisma.meeting.update({ where: { id: m.id }, data: { audioPath: path, audioMime: audio.mime } });
      } catch (e) {
        // Don't leave a ghost meeting with no recording — roll back the row, then surface the error.
        await this.prisma.meeting.delete({ where: { id: m.id } }).catch(() => undefined);
        throw e;
      }
    }
    return this.shape((await this.prisma.meeting.findUnique({ where: { id: m.id } })) ?? m);
  }

  async list(q?: string) {
    const rows = await this.prisma.meeting.findMany({ orderBy: { createdAt: 'desc' }, take: 1000 });
    let list = rows.map((m) => this.shape(m));
    if (q?.trim()) {
      const s = q.toLowerCase();
      list = list.filter((m) => [m.title, m.summary, m.transcript, ...(m.takeaways || []), ...(m.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(s));
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

  /** Delete just the recording (keep the meeting + transcript). Frees disk on long meetings. */
  async deleteAudio(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return null;
    if (m.audioPath) await fs.unlink(m.audioPath).catch(() => undefined);
    await this.prisma.meeting.update({ where: { id }, data: { audioPath: null, audioMime: null } });
    return { ok: true };
  }

  async getAutoDeleteAudio(): Promise<boolean> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'meetings.autoDeleteAudio' } });
    return row?.value === 'true';
  }

  async setAutoDeleteAudio(on: boolean): Promise<{ enabled: boolean }> {
    await this.prisma.setting.upsert({ where: { key: 'meetings.autoDeleteAudio' }, create: { key: 'meetings.autoDeleteAudio', value: on ? 'true' : 'false' }, update: { value: on ? 'true' : 'false' } });
    return { enabled: on };
  }

  // ---- share + memory ----

  async setShared(id: string, shared: boolean) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return null;
    await this.prisma.meeting.update({ where: { id }, data: { shared: !!shared } });
    return { shared: !!shared };
  }

  /** Public payload for a shared meeting — summary/takeaways/decisions/action items only.
   *  The full transcript and audio are intentionally NOT exposed. */
  async getShared(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m || !m.shared) return null;
    return {
      title: m.title,
      createdAt: m.createdAt,
      durationSec: m.durationSec,
      summary: m.summary,
      takeaways: parseArr(m.takeaways),
      decisions: parseArr(m.decisions),
      actionItems: parseArr(m.actionItems),
    };
  }

  /** Opt-in: store this meeting's write-up into the searchable memory (RAG + SuperMemory). */
  async saveToMemory(id: string) {
    const m = await this.prisma.meeting.findUnique({ where: { id } });
    if (!m) return null;
    const takeaways = parseArr(m.takeaways);
    const decisions = parseArr(m.decisions);
    const actions = parseArr(m.actionItems).map((a: any) => (typeof a === 'string' ? a : a?.title)).filter(Boolean);
    const parts = [
      m.title,
      m.summary || '',
      takeaways.length ? 'Key takeaways:\n' + takeaways.map((t: string) => `- ${t}`).join('\n') : '',
      decisions.length ? 'Decisions:\n' + decisions.map((t: string) => `- ${t}`).join('\n') : '',
      actions.length ? 'Action items:\n' + actions.map((t: string) => `- ${t}`).join('\n') : '',
    ].filter(Boolean);
    const text = parts.join('\n\n').trim();
    if (!text) return { saved: false };
    // Replace-on-edit, linked to the meeting row (re-summarising replaces, no duplicate). (BEA-342)
    await this.memory.indexEntity({ refType: 'meeting', refId: id, title: m.title, content: text, tags: ['meeting'], prevSupermemoryId: (m as any).supermemoryId, prevRagId: (m as any).ragId });
    await this.prisma.meeting.update({ where: { id }, data: { savedToMemory: true } });
    return { saved: true };
  }
}
