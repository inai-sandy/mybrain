import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';

export type LlmConfig = { provider: 'anthropic' | 'openrouter'; model: string };

@Injectable()
export class LlmService {
  constructor(
    private readonly connectors: ConnectorService,
    private readonly prisma: PrismaService,
  ) {}

  async getConfig(): Promise<LlmConfig | null> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'llm' } });
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }

  async setConfig(provider: string, model: string): Promise<void> {
    const value = JSON.stringify({ provider, model });
    await this.prisma.setting.upsert({ where: { key: 'llm' }, create: { key: 'llm', value }, update: { value } });
  }

  /** Live OpenRouter model list, optionally restricted to id prefixes (e.g. ['openai/','anthropic/']). */
  async listOpenRouterModels(prefixes: string[] = []): Promise<{ id: string; name: string }[]> {
    try {
      const c = await this.connectors.get<{ apiKey: string }>('openrouter');
      const r = await fetch('https://openrouter.ai/api/v1/models', {
        headers: c?.apiKey ? { Authorization: `Bearer ${c.apiKey}` } : {},
      });
      if (!r.ok) return [];
      const d: any = await r.json();
      const list = Array.isArray(d.data) ? d.data : [];
      return list
        .filter((m: any) => !prefixes.length || prefixes.some((p) => String(m.id).startsWith(p)))
        .map((m: any) => ({ id: m.id, name: m.name || m.id }))
        .sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch {
      return [];
    }
  }

  /** Single-shot completion via the app's default provider+model. Returns text, or null if unavailable. */
  async complete(prompt: string, maxTokens = 400): Promise<string | null> {
    return this.completeWith(await this.getConfig(), prompt, maxTokens);
  }

  /** Single-shot completion forcing a specific provider+model (e.g. the Tasks engine's Sonnet). */
  async completeWith(cfg: LlmConfig | null, prompt: string, maxTokens = 400): Promise<string | null> {
    if (!cfg?.provider || !cfg?.model) return null;
    try {
      if (cfg.provider === 'anthropic') {
        const c = await this.connectors.get<{ apiKey: string }>('anthropic');
        if (!c?.apiKey) return null;
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        return d?.content?.[0]?.text ?? null;
      }
      if (cfg.provider === 'openrouter') {
        const c = await this.connectors.get<{ apiKey: string }>('openrouter');
        if (!c?.apiKey) return null;
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        return d?.choices?.[0]?.message?.content ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }
}
