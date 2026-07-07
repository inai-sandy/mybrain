import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** Curated, known-good model ids (openrouter). Brain = smart; Talk = fast. */
export const EMO_MODELS = ['anthropic/claude-sonnet-4.6', 'anthropic/claude-haiku-4.5', 'openai/gpt-4o', 'openai/gpt-4o-mini'];
export const EMO_VOICES = ['nova', 'alloy', 'echo', 'shimmer', 'onyx', 'fable', 'coral', 'sage'];
export const STT_ENGINES = ['openai', 'deepgram'];

export type EmoSettings = {
  ttsVoice: string;
  sttEngine: string;
  brainModel: string;
  talkModel: string;
  searchDefault: 'on' | 'off' | 'auto';
  vocabulary: string;
};

/**
 * EMO settings (BEA-908) — the single source of truth shared by the web app and the mobile app.
 * Backed by the key/value Setting table (reuses the existing voice.*/explore.llm keys + new emo.*).
 */
@Injectable()
export class EmoSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  private async g(key: string): Promise<string | null> {
    return (await this.prisma.setting.findUnique({ where: { key } }))?.value ?? null;
  }
  private async s(key: string, value: string) {
    await this.prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
  private modelOf(raw: string | null, fallback: string): string {
    if (!raw) return fallback;
    try { const v = JSON.parse(raw); return v?.model || fallback; } catch { return fallback; }
  }

  async get(): Promise<EmoSettings & { voices: string[]; models: string[]; sttEngines: string[] }> {
    const searchDefault = ((await this.g('emo.search.default')) as any) || 'auto';
    return {
      ttsVoice: (await this.g('voice.ttsVoice')) || 'nova',
      sttEngine: (await this.g('voice.engine')) || 'openai',
      brainModel: this.modelOf(await this.g('explore.llm'), 'anthropic/claude-sonnet-4.6'),
      talkModel: this.modelOf(await this.g('emo.talk.model'), 'anthropic/claude-haiku-4.5'),
      searchDefault: ['on', 'off', 'auto'].includes(searchDefault) ? searchDefault : 'auto',
      vocabulary: (await this.g('voice.vocabulary')) || '',
      voices: EMO_VOICES,
      models: EMO_MODELS,
      sttEngines: STT_ENGINES,
    };
  }

  async set(patch: Partial<EmoSettings>): Promise<EmoSettings & { voices: string[]; models: string[]; sttEngines: string[] }> {
    if (patch.ttsVoice && EMO_VOICES.includes(patch.ttsVoice)) await this.s('voice.ttsVoice', patch.ttsVoice);
    if (patch.sttEngine && STT_ENGINES.includes(patch.sttEngine)) await this.s('voice.engine', patch.sttEngine);
    if (patch.brainModel) await this.s('explore.llm', JSON.stringify({ provider: 'openrouter', model: patch.brainModel }));
    if (patch.talkModel) await this.s('emo.talk.model', JSON.stringify({ provider: 'openrouter', model: patch.talkModel }));
    if (patch.searchDefault && ['on', 'off', 'auto'].includes(patch.searchDefault)) await this.s('emo.search.default', patch.searchDefault);
    if (patch.vocabulary !== undefined) await this.s('voice.vocabulary', String(patch.vocabulary).slice(0, 2000));
    return this.get();
  }
}
