import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorService, ConnectorName } from '../connectors/connector.service';
import { LlmService } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

export type Engine = 'openai' | 'elevenlabs' | 'deepgram' | 'gemini';

const ENGINES: { id: Engine; name: string; connector: ConnectorName }[] = [
  { id: 'openai', name: 'OpenAI GPT-4o Transcribe (recommended)', connector: 'openai' },
  { id: 'elevenlabs', name: 'ElevenLabs Scribe (most accurate on English)', connector: 'elevenlabs' },
  { id: 'deepgram', name: 'Deepgram Nova-3 (fast)', connector: 'deepgram' },
  { id: 'gemini', name: 'Gemini (via OpenRouter)', connector: 'openrouter' },
];

const ttsCache = new Map<string, Buffer>(); // spoken fillers/ack repeat → instant after first generation (BEA-889)

/** One transcription engine for the whole app (in-app mic + Telegram voice): record → STT → optional AI cleanup. */
@Injectable()
export class VoiceService {
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
  async cleanupOn(): Promise<boolean> {
    return (await this.getSetting('voice.cleanup')) !== '0';
  }
  async setCleanup(on: boolean) {
    await this.setSetting('voice.cleanup', on ? '1' : '0');
    return { cleanup: on };
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
    return { engine: await this.getEngine(), engines: await this.engines(), cleanup: await this.cleanupOn(), language: await this.language(), vocabulary: await this.voiceVocabulary() };
  }

  // ---- transcription ----
  /** Transcribe audio with the chosen engine (falling back to OpenAI), then optionally clean it up. */
  async transcribe(buf: Buffer, filename = 'audio.webm', mime = 'audio/webm'): Promise<string> {
    if (!buf?.length) return '';
    const engine = await this.getEngine();
    let used: Engine = engine;
    let text = await this.run(engine, buf, filename, mime).catch(() => null);
    if (!text && engine !== 'openai') {
      used = 'openai';
      text = await this.run('openai', buf, filename, mime).catch(() => null);
    }
    if (!text) return '';
    // Log the request (STT providers don't return a $ figure — cost stays in the provider totals).
    const sttModel: Record<Engine, string> = { openai: 'gpt-4o-transcribe', elevenlabs: 'scribe_v1', deepgram: 'nova-3', gemini: 'gemini-3-flash' };
    const loggedModel = used === 'deepgram' ? await this.getDeepgramModel() : sttModel[used];
    await this.prisma.usageLog.create({ data: { feature: 'voice-transcribe', model: loggedModel, cost: null } }).catch(() => undefined);
    if (await this.cleanupOn()) text = await this.clean(text).catch(() => text);
    return (text || '').trim();
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
      const sttModel: Record<Engine, string> = { openai: 'gpt-4o-transcribe', elevenlabs: 'scribe_v1', deepgram: 'nova-3', gemini: 'gemini-3-flash' };
      const model = used === 'deepgram' ? await this.getDeepgramModel() : sttModel[used];
      await this.prisma.usageLog.create({ data: { feature: 'meeting-transcribe', model, cost: null } }).catch(() => undefined);
    }
    return (text || '').trim();
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

  private async openai(buf: Buffer, filename: string): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('openai');
    if (!c?.apiKey) return null;
    const lang = await this.language();
    const hint = await this.promptHint();
    const call = async (model: string) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buf)]), filename);
      form.append('model', model);
      if (lang) form.append('language', lang);
      if (hint) form.append('prompt', hint); // bias toward the user's real names/terms (BEA-888)
      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${c.apiKey}` }, body: form as any });
      if (!r.ok) return null;
      const d: any = await r.json();
      return d?.text?.trim() || null;
    };
    // Best model first; fall back to whisper-1 if the account can't use gpt-4o-transcribe yet.
    return (await call('gpt-4o-transcribe')) || (await call('whisper-1'));
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

  private async deepgram(buf: Buffer, mime: string): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('deepgram');
    if (!c?.apiKey) return null;
    const model = await this.getDeepgramModel();
    const r = await fetch(`https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true&punctuate=true`, {
      method: 'POST',
      headers: { Authorization: `Token ${c.apiKey}`, 'Content-Type': mime || 'audio/webm' },
      body: new Uint8Array(buf),
    });
    if (!r.ok) return null;
    const d: any = await r.json();
    return d?.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || null;
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
    const out = (await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, `${tmpl}${ctx}\n\nTRANSCRIPT:\n${raw}`, Math.min(2000, Math.round(raw.length / 2) + 300), 'voice-cleanup'))?.trim();
    if (!out) return raw;
    // Guard against the model "replying" instead of cleaning (e.g. on garbled/non-speech input).
    const looksLikeMeta = /\b(i don'?t see|please provide|no (transcript|text)|i can'?t|as an ai|it (looks|seems) like)\b/i.test(out) && out.length > raw.length + 40;
    return looksLikeMeta ? raw : out;
  }
}
