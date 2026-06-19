import { Injectable } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';

export type LlmConfig = { provider: 'anthropic' | 'openrouter' | 'codex' | 'gemini'; model: string };

// Host-side agent runners (subscription-based engines). The container reaches them on the Docker gateway.
const CODEX_RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';
const GEMINI_RUNNER = process.env.GEMINI_RUNNER_URL || 'http://172.18.0.1:8767';

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

  /** Record one AI request's cost (never blocks or fails the actual request). */
  private async logUsage(feature: string, model: string, usage: any): Promise<void> {
    try {
      await this.prisma.usageLog.create({
        data: {
          feature,
          model,
          promptTokens: usage?.prompt_tokens ?? usage?.input_tokens ?? null,
          completionTokens: usage?.completion_tokens ?? usage?.output_tokens ?? null,
          cost: typeof usage?.cost === 'number' ? usage.cost : null,
        },
      });
    } catch {
      /* usage logging must never break the request */
    }
  }

  /** Single-shot completion via the app's default provider+model. Returns text, or null if unavailable. */
  async complete(prompt: string, maxTokens = 400, label = 'other'): Promise<string | null> {
    return this.completeWith(await this.getConfig(), prompt, maxTokens, label);
  }

  /** Single-shot completion forcing a specific provider+model (e.g. the Tasks engine's Sonnet). */
  async completeWith(cfg: LlmConfig | null, prompt: string, maxTokens = 400, label = 'other'): Promise<string | null> {
    if (!cfg?.provider || !cfg?.model) return null;
    try {
      // Subscription agents (Codex / Gemini) — route the prompt to the host runner; no per-call API $.
      if (cfg.provider === 'codex' || cfg.provider === 'gemini') {
        const url = cfg.provider === 'codex' ? CODEX_RUNNER : GEMINI_RUNNER;
        // For Gemini, cfg.model carries the specific Antigravity model name (e.g. "Gemini 3.5 Flash").
        const model = cfg.provider === 'gemini' && cfg.model && cfg.model !== 'gemini' ? cfg.model : undefined;
        const r = await fetch(`${url}/run`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, model }),
          signal: AbortSignal.timeout(190_000),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        return String(d?.text || '').trim() || null;
      }
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
        await this.logUsage(label, cfg.model, d?.usage); // tokens only — Anthropic doesn't return $ cost
        return d?.content?.[0]?.text ?? null;
      }
      if (cfg.provider === 'openrouter') {
        const c = await this.connectors.get<{ apiKey: string }>('openrouter');
        if (!c?.apiKey) return null;
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
          // usage.include → OpenRouter returns the exact cost of THIS request in the response
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, usage: { include: true }, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        await this.logUsage(label, cfg.model, d?.usage);
        return d?.choices?.[0]?.message?.content ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }

  /** Streaming completion — calls onToken as text arrives, returns the full text. Falls back to non-streaming for Anthropic. */
  async completeStream(cfg: LlmConfig | null, prompt: string, maxTokens: number, onToken: (t: string) => void, label = 'chat'): Promise<string | null> {
    if (!cfg?.provider || !cfg?.model) return null;
    if (cfg.provider === 'openrouter') {
      try {
        const c = await this.connectors.get<{ apiKey: string }>('openrouter');
        if (!c?.apiKey) return null;
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, stream: true, usage: { include: true }, messages: [{ role: 'user', content: prompt }] }),
        });
        if (!r.ok || !r.body) return null;
        const { full, usage } = await this.readSse(r.body as any, onToken);
        await this.logUsage(label, cfg.model, usage);
        return full;
      } catch {
        return null;
      }
    }
    // Anthropic (or anything else): no streaming here — emit the whole thing once.
    const full = await this.completeWith(cfg, prompt, maxTokens, label);
    if (full) onToken(full);
    return full;
  }

  private async readSse(body: any, onToken: (t: string) => void): Promise<{ full: string; usage: any }> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    let usage: any = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const tok = j?.choices?.[0]?.delta?.content;
          if (tok) { full += tok; onToken(tok); }
          if (j?.usage) usage = j.usage; // final chunk carries the cost when usage.include is on
        } catch {
          /* ignore keep-alive / partial */
        }
      }
    }
    return { full, usage };
  }
}
