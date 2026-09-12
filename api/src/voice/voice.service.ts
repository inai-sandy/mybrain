import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorService, ConnectorName } from '../connectors/connector.service';
import { gptTooShort, judgeRescue, wordCount, WhisperVerbose } from './whisper-rescue';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { CURATED_MODELS, isCuratedModel } from '../llm/curated-models';

export type Engine = 'openai' | 'elevenlabs' | 'deepgram' | 'gemini';

/** The ONE OpenAI speech-to-text model this app uses (BEA-1625, the owner's choice). */
export const OPENAI_STT_MODEL = 'gpt-transcribe';
/** The OpenAI model that LABELS SPEAKERS in a meeting (2026-09-12). On the owner's first real
 *  two-person meeting Deepgram nova-3 (and nova-2, en and multi) heard ONE speaker; this model heard
 *  two, 37/99 words, with natural turns. Meetings only — dictation stays on OPENAI_STT_MODEL. */
export const OPENAI_DIARIZE_MODEL = 'gpt-4o-transcribe-diarize';
export type MeetingLabeller = 'openai' | 'deepgram';
/** The meeting's language decides WHO labels the speakers (2026-09-12, measured on the owner's two
 *  real meetings): Telugu → Deepgram nova-3 with language=te (2 speakers, Telugu script; OpenAI's
 *  labeller romanises Telugu and split the call into 4 voices; Deepgram's own detect_language called
 *  the call "en" and dropped it to 24 words); English → OpenAI's labeller (2 speakers where Deepgram
 *  heard 1), Deepgram en as the backup. 'auto' sniffs the first 30 s with the owner's own transcriber. */
export type MeetingLanguage = 'auto' | 'te' | 'en';
export const MEETING_SNIFF_SECONDS = 30;
/** Unsure (sniff failed, nothing heard): Telugu — the owner's meetings are Telugu/English by default. */
export const MEETING_LANGUAGE_WHEN_UNSURE: 'te' | 'en' = 'te';

/**
 * A transcription that failed for a reason the owner should SEE. Dictation used to answer '' on
 * every failure, so the mic looked like it had simply heard nothing — the one outcome he cannot
 * debug. This carries a plain sentence up to the controller instead.
 */
export class VoiceTranscribeError extends Error {}

/** A provider could not be REACHED or answered badly (timeout, HTTP 5xx, network). Distinct from
 *  "no speech" (an empty string): a caller with a retry loop (the device road) retries THIS and
 *  files an empty answer as silence. 2026-09-11 meeting-road review: transcribeMeeting swallowed
 *  every provider error into '', so the device's 3-try loop never ran and one Deepgram hiccup filed
 *  an hour-long meeting as "Nothing heard". */
export class VoiceTransportError extends Error {}
/** Deepgram on an hour of audio takes tens of seconds; the default undici limit (5 min) sat between
 *  "slow" and "dead" with nothing deciding. 15 minutes is the ceiling, then it is a transport error. */
export const DEEPGRAM_TIMEOUT_MS = 15 * 60 * 1000;
/** OpenAI's transcription upload limit is 25 MB; an hour of 16 kHz WAV is ~115 MB. Past this the
 *  OpenAI leg is not even tried — it would refuse, and the refusal used to read as "no speech". */
export const OPENAI_MAX_UPLOAD_BYTES = 24 * 1024 * 1024;

const ENGINES: { id: Engine; name: string; connector: ConnectorName }[] = [
  { id: 'openai', name: 'OpenAI GPT Transcribe (recommended)', connector: 'openai' },
  { id: 'elevenlabs', name: 'ElevenLabs Scribe (most accurate on English)', connector: 'elevenlabs' },
  { id: 'deepgram', name: 'Deepgram Nova-3 (fast)', connector: 'deepgram' },
  { id: 'gemini', name: 'Gemini (via OpenRouter)', connector: 'openrouter' },
];

const ttsCache = new Map<string, Buffer>(); // spoken fillers/ack repeat → instant after first generation (BEA-889)

/** One transcription engine for the whole app (in-app mic + Telegram voice): record → STT → optional AI cleanup. */
/** Which language a transcript is written in: Telugu script anywhere worth counting → 'te';
 *  Latin words and no Telugu → 'en'; nothing readable → null (unsure). Pure. */
export function languageOfText(text: string): 'te' | 'en' | null {
  const te = (text.match(/[\u0C00-\u0C7F]/g) || []).length;
  const latin = (text.match(/[A-Za-z]{2,}/g) || []).length;
  if (te >= 8 || (te > 0 && te >= latin)) return 'te';
  if (latin >= 3) return 'en';
  return null;
}
/** The first `seconds` of a 16-bit mono WAV, as a WAV. Pure. */
export function wavHead(wav: Buffer, seconds: number): Buffer {
  if (wav.length < 44) return wav;
  const sr = wav.readUInt32LE(24) || 16000;
  const ch = wav.readUInt16LE(22) || 1;
  const bytes = Math.min(wav.length - 44, Math.floor(sr * ch * 2 * seconds));
  const out = Buffer.concat([wav.subarray(0, 44), wav.subarray(44, 44 + bytes)]);
  out.writeUInt32LE(out.length - 8, 4); out.writeUInt32LE(bytes, 40);
  return out;
}

/** OpenAI diarized_json segments ({speaker:'A'|'B'|…, text}) → "Speaker N: …" lines, N by order of
 *  first appearance, consecutive same-speaker segments merged. Pure. */
export function diarizedToLines(segments: any[]): string[] {
  const order = new Map<string, number>();
  const lines: string[] = [];
  let cur = '';
  for (const s of segments || []) {
    const text = String(s?.text || '').trim();
    if (!text) continue;
    const id = String(s?.speaker ?? '?');
    if (!order.has(id)) order.set(id, order.size + 1);
    const label = `Speaker ${order.get(id)}`;
    if (label !== cur) { lines.push(`${label}: ${text}`); cur = label; }
    else lines[lines.length - 1] += ` ${text}`;
  }
  return lines;
}

/** Deepgram utterances → "Speaker N: …" lines, consecutive same-speaker utterances merged. Pure. */
export function utterancesToLines(utts: any[]): string[] {
  const lines: string[] = [];
  let curSpeaker = -1;
  for (const u of utts || []) {
    const sp = Number.isFinite(u?.speaker) ? Number(u.speaker) : 0;
    const text = String(u?.transcript || '').trim();
    if (!text) continue;
    if (sp !== curSpeaker) { lines.push(`Speaker ${sp + 1}: ${text}`); curSpeaker = sp; }
    else lines[lines.length - 1] += ` ${text}`;
  }
  return lines;
}

@Injectable()
export class VoiceService {
  private readonly log = new Logger('Voice');

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
  ) {}

  // ---- settings ----
  private async getSetting(key: string): Promise<string | null> {
    return (await this.prisma.setting.findUnique({ where: { key } }))?.value ?? null;
  }
  private async setSetting(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  async getEngine(): Promise<Engine> {
    const v = (await this.getSetting('voice.engine')) as Engine;
    if (ENGINES.some((e) => e.id === v)) return v;
    // migrate the old Telegram 'voice.provider' (openai|gemini) if present
    const legacy = await this.getSetting('voice.provider');
    return legacy === 'gemini' ? 'gemini' : 'openai';
  }
  async setEngine(e: string): Promise<{ engine: Engine }> {
    const engine = (ENGINES.find((x) => x.id === e)?.id || 'openai') as Engine;
    await this.setSetting('voice.engine', engine);
    return { engine };
  }
  /** Speaker labels for meetings (owner, 2026-09-11: "keep this diarization nova 3 settings as an
   *  optional"). On (default): a MEETING take goes to Deepgram with diarization → Speaker 1/2 lines.
   *  Off: it goes to the chosen engine like every other take — better words on mixed Telugu/English,
   *  no labels. Setting `voice.meetingLabels`, '0' = off. */
  async meetingLabelsOn(): Promise<boolean> {
    return (await this.getSetting('voice.meetingLabels')) !== '0';
  }
  async setMeetingLabels(on: boolean): Promise<{ meetingLabels: boolean }> {
    await this.setSetting('voice.meetingLabels', on ? '1' : '0');
    return { meetingLabels: on };
  }
  /** Meeting language: 'auto' (default — a 30 s sniff per meeting), 'te' or 'en'. It decides the
   *  labeller (see MeetingLanguage). */
  async meetingLanguage(): Promise<MeetingLanguage> {
    const v = await this.getSetting('voice.meetingLanguage');
    return v === 'te' || v === 'en' ? v : 'auto';
  }
  async setMeetingLanguage(which: string): Promise<{ meetingLanguage: MeetingLanguage }> {
    const w: MeetingLanguage = which === 'te' || which === 'en' ? which : 'auto';
    await this.setSetting('voice.meetingLanguage', w);
    return { meetingLanguage: w };
  }
  /** The first MEETING_SNIFF_SECONDS of a WAV through the owner's own transcriber (it reads mixed
   *  speech right, and writes Telugu in Telugu script) → 'te' | 'en'. Never throws: unsure → the
   *  default. ~2-3 s and a fraction of a paisa. */
  async sniffMeetingLanguage(buf: Buffer, mime = 'audio/wav'): Promise<'te' | 'en'> {
    try {
      const head = mime === 'audio/wav' ? wavHead(buf, MEETING_SNIFF_SECONDS) : buf;
      const text = await this.run('openai', head, 'sniff.wav', mime);
      const lang = languageOfText(text || '');
      this.log.log(`meeting: sniffed ${lang === 'te' ? 'Telugu' : 'English'} from the first ${MEETING_SNIFF_SECONDS} s (${(text || '').slice(0, 40).replace(/\n/g, ' ')}…)`);
      return lang ?? MEETING_LANGUAGE_WHEN_UNSURE;
    } catch (e: any) {
      this.log.warn(`meeting: language sniff failed (${e?.message || e}) — assuming ${MEETING_LANGUAGE_WHEN_UNSURE}`);
      return MEETING_LANGUAGE_WHEN_UNSURE;
    }
  }
  async cleanupOn(): Promise<boolean> {
    return (await this.getSetting('voice.cleanup')) !== '0';
  }
  async setCleanup(on: boolean) {
    await this.setSetting('voice.cleanup', on ? '1' : '0');
    return { cleanup: on };
  }
  /**
   * The model that tidies dictation (BEA-1624). Read through the named-helper road — the
   * `voice-cleanup` entry in `LlmService.HELPERS`, whose row is `voice.cleanup.model` — so this
   * service never carries a model id of its own, and a blank or unreadable row falls back to the
   * helper's default rather than to anything cheaper.
   */
  async cleanupModel(): Promise<string> {
    const cfg = await this.llm.helperModel?.('voice-cleanup').catch(() => null);
    return cfg?.model || LlmService.HELPERS['voice-cleanup']!.model;
  }
  /** Only a model from the curated list may be saved; '' = back to the default. */
  async setCleanupModel(model: string): Promise<{ model: string }> {
    const m = (model || '').trim();
    if (m && !isCuratedModel(m)) throw new Error(`Unknown model: ${m}`);
    await this.llm.setHelperModel('voice-cleanup', m);
    return { model: await this.cleanupModel() };
  }
  async language(): Promise<string> {
    return (await this.getSetting('voice.language')) || '';
  }
  async setLanguage(l: string) {
    await this.setSetting('voice.language', (l || '').trim().slice(0, 10));
    return { language: await this.language() };
  }
  /** Optional user vocabulary (project words, place names…) mixed into the transcription hint. */
  async voiceVocabulary(): Promise<string> {
    return (await this.getSetting('voice.vocabulary')) || '';
  }
  async setVoiceVocabulary(v: string) {
    await this.setSetting('voice.vocabulary', (v || '').trim().slice(0, 2000));
    return { vocabulary: await this.voiceVocabulary() };
  }
  /** The OpenAI voice EMO speaks in (same voice we embed on the device). */
  async ttsVoice(): Promise<string> {
    return (await this.getSetting('voice.ttsVoice')) || 'nova';
  }
  async setTtsVoice(v: string) {
    await this.setSetting('voice.ttsVoice', (v || 'nova').trim().slice(0, 30));
    return { voice: await this.ttsVoice() };
  }
  /** Speak text with OpenAI TTS → mp3 bytes. Cached by voice+text so ack/fillers are instant on repeat (BEA-889). */
  async tts(text: string, voice?: string): Promise<Buffer | null> {
    const t = (text || '').trim().slice(0, 800);
    if (!t) return null;
    const v = (voice || (await this.ttsVoice())).trim();
    const key = `${v}:${t}`;
    const hit = ttsCache.get(key);
    if (hit) return hit;
    const c = await this.connectors.get<{ apiKey: string }>('openai');
    if (!c?.apiKey) return null;
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v, input: t }),
    }).catch(() => null);
    if (!r || !r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (ttsCache.size > 200) ttsCache.clear();
    ttsCache.set(key, buf);
    await this.prisma.usageLog.create({ data: { feature: 'voice-tts', model: 'gpt-4o-mini-tts', cost: null } }).catch(() => undefined);
    return buf;
  }
  /** Raw 24 kHz 16-bit mono PCM speech (BEA-926: the EMO device resamples + WAV-wraps it). */
  async ttsPcm(text: string, voice?: string): Promise<Buffer | null> {
    const t = (text || '').trim().slice(0, 800);
    if (!t) return null;
    const v = (voice || (await this.ttsVoice())).trim();
    const c = await this.connectors.get<{ apiKey: string }>('openai');
    if (!c?.apiKey) return null;
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: v, input: t, response_format: 'pcm' }),
    }).catch(() => null);
    if (!r || !r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    await this.prisma.usageLog.create({ data: { feature: 'voice-tts', model: 'gpt-4o-mini-tts', cost: null } }).catch(() => undefined);
    return buf;
  }
  /** A short context hint biasing transcription toward the user's real names + terms (BEA-888). */
  private async promptHint(): Promise<string> {
    try {
      const names = (await this.prisma.contact.findMany({ select: { name: true }, take: 200 }))
        .map((c: any) => (c.name || '').trim())
        .filter(Boolean);
      const vocab = (await this.voiceVocabulary()).trim();
      const parts: string[] = [];
      if (names.length) parts.push(`People who may be mentioned by name: ${names.join(', ')}.`);
      if (vocab) parts.push(`Common terms: ${vocab}.`);
      return parts.join(' ').slice(0, 900); // ~200 tokens, OpenAI's prompt cap
    } catch {
      return '';
    }
  }

  /** Engines with a 'configured' flag (does the user have the key?). */
  async engines() {
    const out = [];
    for (const e of ENGINES) {
      const c = await this.connectors.get<any>(e.connector).catch(() => null);
      out.push({ id: e.id, name: e.name, configured: !!(c?.apiKey || c?.token) });
    }
    return out;
  }

  async config() {
    return {
      engine: await this.getEngine(),
      engines: await this.engines(),
      cleanup: await this.cleanupOn(),
      meetingLabels: await this.meetingLabelsOn(),
      meetingLanguage: await this.meetingLanguage(),
      cleanupModel: await this.cleanupModel(),
      cleanupModels: [...CURATED_MODELS],
      language: await this.language(),
      vocabulary: await this.voiceVocabulary(),
    };
  }

  // ---- transcription ----
  /** Transcribe audio with the chosen engine (falling back to OpenAI), then optionally clean it up. */
  async transcribe(buf: Buffer, filename = 'audio.webm', mime = 'audio/webm'): Promise<string> {
    if (!buf?.length) return '';
    const engine = await this.getEngine();
    let used: Engine = engine;
    // A VoiceTranscribeError is deliberately NOT caught here — dictation must say why it failed
    // rather than quietly insert nothing (BEA-1625). Another engine may still fall back to OpenAI.
    let text: string | null;
    if (engine === 'openai') {
      text = await this.run('openai', buf, filename, mime);
    } else {
      text = await this.run(engine, buf, filename, mime).catch(() => null);
      if (!text) {
        used = 'openai';
        text = await this.run('openai', buf, filename, mime);
      }
    }
    if (!text) return '';
    // Log the request (STT providers don't return a $ figure — cost stays in the provider totals).
    const sttModel: Record<Engine, string> = { openai: this.lastOpenAiModel, elevenlabs: 'scribe_v1', deepgram: 'nova-3', gemini: 'gemini-3-flash' };
    const loggedModel = used === 'deepgram' ? await this.getDeepgramModel() : sttModel[used];
    await this.prisma.usageLog.create({ data: { feature: 'voice-transcribe', model: loggedModel, cost: null } }).catch(() => undefined);
    if (await this.cleanupOn()) text = await this.clean(text).catch(() => text);
    return (text || '').trim();
  }

  /** The whisper rescue (2026-09-10, whisper-rescue.ts): when the first engine's answer is implausibly
   *  short for the audio, ask whisper-1 for the same audio WITH its confidence, and keep whisper's
   *  answer only if the guard believes it. Off switch: Setting voice.whisperRescue = '0'. One log line
   *  per decision, so a wrong rescue can be found and the guard tightened from evidence. */
  async whisperRescue(buf: Buffer, filename: string, mime: string, firstText: string, secs: number): Promise<string> {
    const first = (firstText || '').trim();
    if (!buf?.length || !Number.isFinite(secs) || !gptTooShort(first, secs)) return first;
    /* EVERYTHING from here is inside the net: a DB hiccup on the setting read, a missing key, an HTTP
       error or bad JSON must all degrade to "keep the first answer" — never to a thrown take (review). */
    try {
      if ((await this.getSetting('voice.whisperRescue')) === '0') return first;
      const c = await this.connectors.get<{ apiKey: string }>('openai');
      if (!c?.apiKey) return first;
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buf)]), filename || 'audio.wav');
      form.append('model', 'whisper-1');
      form.append('response_format', 'verbose_json');
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form as any });
      if (!r.ok) { this.log.warn(`whisper rescue: HTTP ${r.status} — keeping the first answer`); return first; }
      const v = (await r.json()) as WhisperVerbose;
      const verdict = judgeRescue(v, first, secs);
      this.log.log(`whisper rescue: ${verdict.accept ? 'KEPT whisper' : 'declined'} — ${verdict.why} (first: ${wordCount(first)} words, ${secs.toFixed(0)} s)`);
      if (verdict.accept) {
        await this.prisma.usageLog.create({ data: { feature: 'voice-rescue', model: 'whisper-1', cost: null } }).catch(() => undefined);
        return verdict.text;
      }
      return first;
    } catch (e: any) {
      this.log.warn(`whisper rescue: ${e?.message || e} — keeping the first answer`);
      return first;
    }
  }

  /** Transcribe with a SPECIFIC engine (Meetings module — per-meeting choice). No dictation cleanup; OpenAI fallback. */
  async transcribeWith(engine: string, buf: Buffer, filename = 'audio.webm', mime = 'audio/webm'): Promise<string> {
    if (!buf?.length) return '';
    const e = (ENGINES.find((x) => x.id === engine)?.id || 'deepgram') as Engine;
    let used: Engine = e;
    let text = await this.run(e, buf, filename, mime).catch(() => null);
    if (!text && e !== 'openai') {
      used = 'openai';
      text = await this.run('openai', buf, filename, mime).catch(() => null);
    }
    if (text) {
      const sttModel: Record<Engine, string> = { openai: this.lastOpenAiModel, elevenlabs: 'scribe_v1', deepgram: 'nova-3', gemini: 'gemini-3-flash' };
      const model = used === 'deepgram' ? await this.getDeepgramModel() : sttModel[used];
      await this.prisma.usageLog.create({ data: { feature: 'meeting-transcribe', model, cost: null } }).catch(() => undefined);
    }
    return (text || '').trim();
  }

  /** Meeting transcription with speaker labels (BEA-941): Deepgram diarization →
   *  "Speaker 1: …" lines (consecutive same-speaker utterances merged).
   *
   *  The ladder (2026-09-11 review): labelled → plain Deepgram (labels lost, said in the log) →
   *  OpenAI only when the file fits its 25 MB limit → otherwise THROW VoiceTransportError so the
   *  device road's retry loop runs and, after 3 tries, files "Recording kept — transcription
   *  failed" with the audio kept. An empty string means one thing only: the provider answered and
   *  heard no speech. */
  async transcribeMeeting(buf: Buffer, mime = 'audio/wav'): Promise<string> {
    if (!buf?.length) return '';
    if (!(await this.meetingLabelsOn())) {
      /* the switch is OFF: the chosen engine, like every other take — no labels. A provider failure
         still THROWS (the device road retries); '' still means "heard nothing". */
      const engine = await this.getEngine();
      if (buf.length > OPENAI_MAX_UPLOAD_BYTES && engine === 'openai') throw new VoiceTransportError(`meeting transcription failed — the file (${(buf.length / 1048576).toFixed(0)} MB) is over OpenAI's 25 MB limit and speaker labels are switched off`);
      let text: string | null;
      try { text = await this.run(engine, buf, 'meeting.wav', mime); } catch (e: any) { throw new VoiceTransportError(`meeting transcription failed — ${engine}: ${e?.message || e}`); }
      if (text === null) throw new VoiceTransportError(`meeting transcription failed — ${engine} did not answer`);
      await this.prisma.usageLog.create({ data: { feature: 'meeting-transcribe', model: engine === 'openai' ? this.lastOpenAiModel : engine, cost: null } }).catch(() => undefined);
      return (text || '').trim();
    }
    let lastErr = 'no Deepgram key is connected';
    const pref = await this.meetingLanguage();
    const lang: 'te' | 'en' = pref === 'auto' ? await this.sniffMeetingLanguage(buf, mime) : pref;
    const labeller: MeetingLabeller = lang === 'en' ? 'openai' : 'deepgram';
    if (labeller === 'openai') {
      /* OpenAI first (2026-09-12): a real failure or a file over its 25 MB limit falls through to the
         Deepgram ladder below — the backup, never a dead end. */
      try {
        const lines = await this.openaiDiarize(buf, mime);
        if (lines !== null) {
          await this.prisma.usageLog.create({ data: { feature: 'meeting-transcribe', model: OPENAI_DIARIZE_MODEL, cost: null } }).catch(() => undefined);
          if (lines.length) return lines.join('\n');
          /* answered, heard nothing: silence, not a failure */
          return '';
        }
        lastErr = `the file (${(buf.length / 1048576).toFixed(0)} MB) is over OpenAI's 25 MB limit`;
      } catch (e: any) {
        lastErr = `OpenAI labeller: ${e?.message || e}`;
      }
      this.log.warn(`meeting: ${lastErr} — trying Deepgram (the backup labeller)`);
    }
    const c = await this.connectors.get<{ apiKey: string }>('deepgram').catch(() => null);
    if (!c?.apiKey && lastErr === 'no Deepgram key is connected') lastErr = 'no Deepgram key is connected';
    if (c?.apiKey) {
      const model = await this.getDeepgramModel();
      try {
        const r = await fetch(
          `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&language=${lang}&smart_format=true&punctuate=true&diarize=true&utterances=true${await this.keytermQuery(model)}`,
          { method: 'POST', headers: { Authorization: `Token ${c.apiKey}`, 'Content-Type': mime }, body: new Uint8Array(buf), signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS) },
        );
        if (r.ok) {
          const d: any = await r.json();
          const utts: any[] = Array.isArray(d?.results?.utterances) ? d.results.utterances : [];
          const lines = utterancesToLines(utts);
          await this.prisma.usageLog.create({ data: { feature: 'meeting-transcribe', model: `${model}+diarize`, cost: null } }).catch(() => undefined);
          if (lines.length) return lines.join('\n');
          /* the provider answered and heard nothing: silence, not a failure */
          const plain = String(d?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
          return plain;
        }
        lastErr = `Deepgram diarize HTTP ${r.status}`;
      } catch (e: any) {
        lastErr = `Deepgram diarize: ${e?.name === 'TimeoutError' ? `no answer in ${DEEPGRAM_TIMEOUT_MS / 60000} min` : e?.message || e}`;
      }
      this.log.warn(`meeting: ${lastErr} — trying plain Deepgram (speaker labels will be missing)`);
      try {
        const plain = await this.deepgram(buf, mime, { throwOnTransport: true, language: lang });
        if (plain !== null) {
          await this.prisma.usageLog.create({ data: { feature: 'meeting-transcribe', model, cost: null } }).catch(() => undefined);
          return plain;
        }
      } catch (e: any) {
        lastErr = `plain Deepgram: ${e?.message || e}`;
      }
    }
    if (buf.length <= OPENAI_MAX_UPLOAD_BYTES) {
      this.log.warn(`meeting: ${lastErr} — trying OpenAI (no speaker labels)`);
      try {
        const text = await this.run('openai', buf, 'meeting.wav', mime);
        if (text !== null) {
          await this.prisma.usageLog.create({ data: { feature: 'meeting-transcribe', model: this.lastOpenAiModel, cost: null } }).catch(() => undefined);
          return (text || '').trim();
        }
      } catch (e: any) {
        lastErr = `OpenAI: ${e?.message || e}`;
      }
    } else {
      lastErr += `; the file (${(buf.length / 1048576).toFixed(0)} MB) is over OpenAI's 25 MB limit`;
    }
    throw new VoiceTransportError(`meeting transcription failed — ${lastErr}`);
  }

  private async run(engine: Engine, buf: Buffer, filename: string, mime: string): Promise<string | null> {
    switch (engine) {
      case 'elevenlabs':
        return this.elevenlabs(buf, filename, mime);
      case 'deepgram':
        return this.deepgram(buf, mime);
      case 'gemini':
        return this.gemini(buf, filename);
      case 'openai':
      default:
        return this.openai(buf, filename);
    }
  }

  /** The OpenAI model that produced the LAST successful transcription — so the usage log names
   *  what actually ran, not what we hoped ran (a fallback spans a real price difference). (BEA-1218) */
  private lastOpenAiModel = OPENAI_STT_MODEL;

  /**
   * ONE model, on purpose (BEA-1625). The owner's choice is `gpt-transcribe` and nothing else:
   * no `gpt-4o-transcribe`, no `whisper-1`, and no "that model is down" latch. The chain hid which
   * model actually ran across a real price difference, and the latch could disable dictation for
   * the rest of the day after a single bad response. A refusal is now THROWN, never returned as
   * null, because null reaches the mic as silence.
   */
  private async openai(buf: Buffer, filename: string): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('openai');
    if (!c?.apiKey) throw new VoiceTranscribeError('No OpenAI key is connected — add one in Settings → Connections.');
    const lang = await this.language();
    const hint = await this.promptHint();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)]), filename);
    form.append('model', OPENAI_STT_MODEL);
    if (lang) form.append('language', lang);
    if (hint) form.append('prompt', hint); // bias toward the user's real names/terms (BEA-888)
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form as any });
    if (!r.ok) {
      const detail = (await (typeof r.text === 'function' ? r.text() : Promise.resolve('')).catch(() => '')).slice(0, 200);
      this.log.warn(`${OPENAI_STT_MODEL} refused by OpenAI (HTTP ${r.status}) ${detail}`);
      throw new VoiceTranscribeError(`OpenAI could not transcribe that (${r.status}) — nothing was written down. Try again.`);
    }
    const d: any = await r.json();
    const text = d?.text?.trim() || null;
    if (text) this.lastOpenAiModel = OPENAI_STT_MODEL;
    return text;
  }

  private async elevenlabs(buf: Buffer, filename: string, mime: string): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('elevenlabs');
    if (!c?.apiKey) return null;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)], { type: mime }), filename);
    form.append('model_id', 'scribe_v1');
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': c.apiKey }, body: form as any });
    if (!r.ok) return null;
    const d: any = await r.json();
    return d?.text?.trim() || null;
  }

  /** The chosen Deepgram STT model (default nova-3). Used by both meeting + voice transcription. */
  async getDeepgramModel(): Promise<string> {
    return (await this.getSetting('voice.deepgramModel')) || 'nova-3';
  }

  async setDeepgramModel(model: string): Promise<{ model: string }> {
    const m = (model || 'nova-3').trim().replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 60) || 'nova-3';
    await this.setSetting('voice.deepgramModel', m);
    return { model: m };
  }

  /** Live list of Deepgram's speech-to-text models (needs the Deepgram key). */
  async deepgramModels(): Promise<{ id: string; name: string }[]> {
    const c = await this.connectors.get<{ apiKey: string }>('deepgram').catch(() => null);
    if (!c?.apiKey) return [];
    try {
      const r = await fetch('https://api.deepgram.com/v1/models', { headers: { Authorization: `Token ${c.apiKey}` } });
      if (!r.ok) return [];
      const d: any = await r.json();
      const stt = Array.isArray(d?.stt) ? d.stt : [];
      const seen = new Set<string>();
      return stt
        .map((m: any) => {
          const id = m.canonical_name || m.name;
          const langs = Array.isArray(m.languages) ? m.languages : [];
          const langTxt = langs.length ? ` · ${langs.slice(0, 3).join(', ')}${langs.length > 3 ? '…' : ''}` : '';
          return { id, name: `${m.name}${langTxt}` };
        })
        .filter((x: any) => x.id && !seen.has(x.id) && seen.add(x.id))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  /** Mint a short-lived Deepgram token so the browser can stream audio directly (key stays server-side).
   *  Returns null when Deepgram isn't configured → the client falls back to record-then-transcribe. */
  async streamToken(): Promise<{ token: string; model: string; expiresIn: number } | null> {
    // Live streaming is Deepgram-only. If the user chose another engine, return null so the client
    // records the clip and batch-transcribes with the CHOSEN engine instead (BEA-888).
    if ((await this.getEngine()) !== 'deepgram') return null;
    const c = await this.connectors.get<{ apiKey: string }>('deepgram').catch(() => null);
    if (!c?.apiKey) return null;
    try {
      const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
        method: 'POST',
        headers: { Authorization: `Token ${c.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl_seconds: 60 }),
      });
      if (!r.ok) return null;
      const d: any = await r.json();
      if (!d?.access_token) return null;
      await this.prisma.usageLog.create({ data: { feature: 'voice-stream', model: await this.getDeepgramModel(), cost: null } }).catch(() => undefined);
      return { token: d.access_token, model: await this.getDeepgramModel(), expiresIn: Number(d.expires_in) || 60 };
    } catch {
      return null;
    }
  }

  /** Clean a streamed transcript with the AI tidy-up (respects the user's cleanup setting). */
  async cleanText(text: string): Promise<string> {
    const raw = (text || '').trim();
    if (!raw) return '';
    if (!(await this.cleanupOn())) return raw;
    return (await this.clean(raw).catch(() => raw)).trim();
  }

  /** &keyterm=… boosts for the user's dictionary (names!) — nova-3 only. (BEA-949) */
  private async keytermQuery(model: string): Promise<string> {
    if (!model.startsWith('nova-3')) return '';
    const vocab = (await this.getSetting('voice.vocabulary')) || '';
    return vocab.split(',').map((w) => w.trim()).filter(Boolean).slice(0, 80)
      .map((w) => `&keyterm=${encodeURIComponent(w)}`).join('');
  }

  /** OpenAI's speaker-labelling transcription → "Speaker N: …" lines (speakers numbered in order
   *  of first appearance). null = the file is over the upload limit (not tried); throws on a
   *  transport failure; [] = answered and heard nothing. */
  private async openaiDiarize(buf: Buffer, mime: string): Promise<string[] | null> {
    if (buf.length > OPENAI_MAX_UPLOAD_BYTES) return null;
    const c = await this.connectors.get<{ apiKey: string }>('openai');
    if (!c?.apiKey) throw new VoiceTransportError('no OpenAI key is connected');
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buf)]), mime === 'audio/wav' ? 'meeting.wav' : 'meeting.webm');
    form.append('model', OPENAI_DIARIZE_MODEL);
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');           /* required above 30 s; the model cuts on voice activity */
    let r: Response;
    try {
      r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form as any, signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS) });
    } catch (e: any) {
      throw new VoiceTransportError(e?.name === 'TimeoutError' ? `no answer in ${DEEPGRAM_TIMEOUT_MS / 60000} min` : String(e?.message || e));
    }
    if (!r.ok) throw new VoiceTransportError(`HTTP ${r.status}`);
    const d: any = await r.json();
    return diarizedToLines(Array.isArray(d?.segments) ? d.segments : []);
  }

  /** Plain Deepgram. Engine road (default): null on anything but text, as every runner does.
   *  `throwOnTransport` (the meeting ladder): a transport failure THROWS, and "heard nothing" is ''. */
  private async deepgram(buf: Buffer, mime: string, opts: { throwOnTransport?: boolean; language?: string } = {}): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('deepgram');
    if (!c?.apiKey) { if (opts.throwOnTransport) throw new VoiceTransportError('no Deepgram key is connected'); return null; }
    const model = await this.getDeepgramModel();
    let r: Response;
    try {
      r = await fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}${opts.language ? `&language=${opts.language}` : ''}&smart_format=true&punctuate=true${await this.keytermQuery(model)}`, {
        method: 'POST',
        headers: { Authorization: `Token ${c.apiKey}`, 'Content-Type': mime || 'audio/webm' },
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(DEEPGRAM_TIMEOUT_MS),
      });
    } catch (e: any) {
      if (opts.throwOnTransport) throw new VoiceTransportError(e?.name === 'TimeoutError' ? `no answer in ${DEEPGRAM_TIMEOUT_MS / 60000} min` : String(e?.message || e));
      return null;
    }
    if (!r.ok) { if (opts.throwOnTransport) throw new VoiceTransportError(`HTTP ${r.status}`); return null; }
    const d: any = await r.json();
    const text = d?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || '';
    return opts.throwOnTransport ? text : text || null;
  }

  private async gemini(buf: Buffer, filename: string): Promise<string | null> {
    const or = await this.connectors.get<{ apiKey: string }>('openrouter');
    if (!or?.apiKey) return null;
    const ext = (filename.split('.').pop() || 'webm').toLowerCase();
    const format = ext === 'oga' ? 'ogg' : ext;
    const body = {
      model: 'google/gemini-3-flash-preview',
      max_tokens: 2000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Transcribe this audio verbatim. Output only the transcription, nothing else.' }, { type: 'input_audio', input_audio: { data: buf.toString('base64'), format } }] }],
    };
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${or.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const d: any = await r.json();
    const t = d?.choices?.[0]?.message?.content;
    return typeof t === 'string' && t.trim() ? t.trim() : null;
  }

  /** Light AI cleanup: punctuation, capitals, filler removal — faithful to the user's words. */
  private async clean(text: string): Promise<string> {
    const raw = (text || '').trim();
    if (raw.length < 3) return raw; // nothing meaningful to clean
    const tmpl = await this.prompts.get('voice.cleanup');
    const hint = await this.promptHint();
    const ctx = hint ? `\n\nCONTEXT — if a name or term was clearly misheard, correct it to one of these (do NOT add anything new):\n${hint}` : '';
    // The model is the owner's setting, read through the named-helper road (BEA-1624) — never an id
    // written here. The helper is interactive: one call, and a blank keeps the raw transcript.
    const out = (await this.llm.completeHelper('voice-cleanup', `${tmpl}${ctx}\n\nTRANSCRIPT:\n${raw}`, Math.min(2000, Math.round(raw.length / 2) + 300), 'voice-cleanup'))?.trim();
    if (!out) return raw;
    // Guard against the model "replying" instead of cleaning (e.g. on garbled/non-speech input).
    const looksLikeMeta = /\b(i don'?t see|please provide|no (transcript|text)|i can'?t|as an ai|it (looks|seems) like)\b/i.test(out) && out.length > raw.length + 40;
    return looksLikeMeta ? raw : out;
  }
}
