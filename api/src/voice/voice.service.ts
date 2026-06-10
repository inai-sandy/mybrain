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
    return { engine: await this.getEngine(), engines: await this.engines(), cleanup: await this.cleanupOn(), language: await this.language() };
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
    await this.prisma.usageLog.create({ data: { feature: 'voice-transcribe', model: sttModel[used], cost: null } }).catch(() => undefined);
    if (await this.cleanupOn()) text = await this.clean(text).catch(() => text);
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
    const call = async (model: string) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(buf)]), filename);
      form.append('model', model);
      if (lang) form.append('language', lang);
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

  private async deepgram(buf: Buffer, mime: string): Promise<string | null> {
    const c = await this.connectors.get<{ apiKey: string }>('deepgram');
    if (!c?.apiKey) return null;
    const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true', {
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
    const out = (await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, `${tmpl}\n\nTRANSCRIPT:\n${raw}`, Math.min(2000, Math.round(raw.length / 2) + 300), 'voice-cleanup'))?.trim();
    if (!out) return raw;
    // Guard against the model "replying" instead of cleaning (e.g. on garbled/non-speech input).
    const looksLikeMeta = /\b(i don'?t see|please provide|no (transcript|text)|i can'?t|as an ai|it (looks|seems) like)\b/i.test(out) && out.length > raw.length + 40;
    return looksLikeMeta ? raw : out;
  }
}
