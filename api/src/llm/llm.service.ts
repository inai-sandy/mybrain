import { Injectable, Logger } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBudgetService, TokenBudgetError, ENGINE_TURN_TOKENS } from './token-budget.service';

export type LlmConfig = { provider: 'anthropic' | 'openrouter' | 'codex' | 'gemini' | 'claude'; model: string };

// Host-side agent runners (subscription-based engines). The container reaches them on the Docker gateway.
/** Ceiling for a single chat completion. Generous enough for a long answer, short enough that a
 *  stalled provider fails fast instead of holding a voice turn open forever. (BEA-1012) */
const LLM_TIMEOUT_MS = 60_000;
const CODEX_RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';
const GEMINI_RUNNER = process.env.GEMINI_RUNNER_URL || 'http://172.18.0.1:8767';
const CLAUDE_RUNNER = process.env.CLAUDE_RUNNER_URL || 'http://172.18.0.1:8768';

/**
 * The engine chain (BEA-1201). Try each flat-rate engine in turn; a PAID model is the last resort.
 *
 * Codex ran dry on 30 July and every call quietly moved to Sonnet over OpenRouter without a word.
 * The fix is not one fallback, it is an order — and the order puts everything we already pay a flat
 * fee for ahead of anything billed per token.
 */
const ENGINE_CHAIN: LlmConfig[] = [
  { provider: 'codex', model: 'codex' },
  { provider: 'claude', model: 'claude' },
  { provider: 'gemini', model: 'Gemini 3.5 Flash' },
];
/** Derived from the chain on purpose — two hand-kept lists would drift and silently misroute. */
const isFlatRate = (p?: string) => ENGINE_CHAIN.some((e) => e.provider === p);

// When a free subscription agent is down/slow/empty, work never silently fails — it falls back to the API on Sonnet.
const AGENT_FALLBACK: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };

@Injectable()
export class LlmService {
  private readonly log = new Logger('Llm');
  constructor(
    private readonly connectors: ConnectorService,
    private readonly prisma: PrismaService,
    // Optional + LAST — spec files construct this positionally with fewer args.
    private readonly budget?: TokenBudgetService, // the daily token ceiling (BEA-1204)
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

  /** Public: log usage for a request made outside this service (e.g. a Codex agent run). (BEA-716) */
  async recordUsage(feature: string, model: string, usage: any, ceiling?: number): Promise<void> {
    return this.logUsage(feature, model, usage, ceiling);
  }

  /** Record one AI request's cost (never blocks or fails the actual request). */
  /**
   * @param ceiling the `maxTokens` this call was given, so we can shout when the reply ran into it.
   */
  private async logUsage(feature: string, model: string, usage: any, ceiling?: number): Promise<void> {
    /**
     * A reply that comes back at EXACTLY its ceiling was cut off mid-sentence, and cut-off replies
     * are how features die quietly here: the mentor wrote nothing for two nights and the weekly
     * review missed three weeks, both silently, both paid for. (BEA-1179)
     *
     * Prompts grow — a new context block here, a richer input there — and the output grows with
     * them, while the ceiling is a number written once and never revisited. Nothing noticed. This
     * is the standing check that makes it impossible to miss next time.
     */
    const out = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
    /**
     * EXACTLY at the ceiling, not merely at-or-above it. (BEA-1179)
     *
     * Some providers treat `max_tokens` as advisory and come back over it — `emo-router`, capped at
     * 800, routinely returns 1,200-2,000. Those replies are complete; nothing is wrong with them.
     * Warning on `>=` made nine healthy features look broken and would have buried the real ones in
     * noise. A reply that stops on precisely the number it was allowed is the one that was cut off.
     */
    if (ceiling && out === ceiling) {
      this.log.warn(`${feature}: reply stopped exactly at its ${ceiling}-token ceiling — it was CUT OFF. Raise the ceiling; an unused one costs nothing.`);
    }
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

  /** The agent-helper jobs whose model is owner-pickable in Settings → Models (BEA-1106).
   *  null default = follow the app's default text model. */
  static readonly HELPERS: Record<string, LlmConfig | null> = {
    'chat-edit': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }, // BEA-1094
    'sync-words': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
    'draft': null,
    'ui-spec': null,
    'flow-plan': null,
    'draft-check': null,
    // Deep research makes two very different calls, so it gets two settings (BEA-1206).
    //
    // PLANNING is "write me six search questions" — measured at ~320 tokens in, ~150 out. A small
    // model does that perfectly. Sending it to the subscription engine is worse than wasteful: a CLI
    // call drags roughly 25,000 tokens of its own system prompt along, so a 470-token job would burn
    // fifty times that from the very allowance the writing needs. Free is not free when it spends the
    // thing you are short of.
    'deep-research-plan': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // WRITING reads ~12,900 tokens of sources and produces the report the owner actually reads. It
    // stays on Codex: the engine is already paid for, and on the API the same call costs ~6 cents.
    'deep-research-write': { provider: 'codex', model: 'codex' },
    // Kept so an existing saved setting still resolves.
    'deep-research': { provider: 'codex', model: 'codex' },
  };

  async helperModel(key: string): Promise<LlmConfig | null> {
    if (!(key in LlmService.HELPERS)) return null;
    const row = await this.prisma.setting.findUnique({ where: { key: `helper.${key}.llm` } }).catch(() => null);
    if (row) { try { const v = JSON.parse((row as any).value); if (v?.provider && v?.model) return v; } catch { /* fall through */ } }
    return LlmService.HELPERS[key];
  }

  async setHelperModel(key: string, model: string): Promise<LlmConfig | null> {
    if (!(key in LlmService.HELPERS)) throw new Error('Unknown helper');
    const cfg = model ? this.agentConfig(undefined, model) : null;
    await this.prisma.setting.upsert({
      where: { key: `helper.${key}.llm` },
      create: { key: `helper.${key}.llm`, value: cfg ? JSON.stringify(cfg) : '' },
      update: { value: cfg ? JSON.stringify(cfg) : '' },
    });
    return cfg;
  }

  /** Complete on a helper's own model (or its default), falling back to the app default model. */
  async completeHelper(key: string, prompt: string, maxTokens = 400, label = 'other'): Promise<string | null> {
    const cfg = await this.helperModel(key);
    if (cfg) {
      const { text } = await this.completeWithModel(cfg, prompt, maxTokens, label);
      if (text) return text;
    }
    return this.complete(prompt, maxTokens, label);
  }

  /** Single-shot completion via the app's default provider+model. Returns text, or null if unavailable. */
  async complete(prompt: string, maxTokens = 400, label = 'other'): Promise<string | null> {
    return this.completeWith(await this.getConfig(), prompt, maxTokens, label);
  }

  /**
   * Like complete(), but says WHY it came back empty (BEA-1194).
   *
   * `completeWith` returns null on any provider error with nothing logged, callers turn that into
   * '', and a flow step recorded it as "done, 0 chars". A research run spent 14 minutes and produced
   * an empty report that way, and the usage log held no trace of the calls at all. A step that could
   * not think has to be able to say so.
   */
  async completeDetailed(prompt: string, maxTokens = 400, label = 'other'): Promise<{ text: string | null; error: string | null }> {
    const cfg = await this.getConfig();
    if (!cfg?.provider || !cfg?.model) return { text: null, error: 'no AI model is set up — pick one in Settings' };
    try {
      const text = await this.completeWith(cfg, prompt, maxTokens, label);
      if (text && text.trim()) return { text, error: null };
      return { text: null, error: `${cfg.model} returned nothing — it may be rate-limited, over its context, or briefly unavailable` };
    } catch (e: any) {
      // A budget stop is not a model failure — say what it really is, in the owner's words.
      if (e instanceof TokenBudgetError) return { text: null, error: String(e.message) };
      return { text: null, error: `${cfg.model} failed: ${String(e?.message || e).slice(0, 160)}` };
    }
  }

  /**
   * Map a Settings-picker selection to a real LlmConfig. The picker sends only a model id; the
   * subscription agents are encoded in it: 'codex', 'gemini', or 'gemini::<Antigravity model>'.
   * Anything else is a normal API model id (default provider openrouter).
   */
  agentConfig(provider: string | undefined, model: string): LlmConfig {
    if (model === 'codex') return { provider: 'codex', model: 'codex' };
    if (model === 'claude') return { provider: 'claude', model: 'claude' };
    if (model === 'gemini') return { provider: 'gemini', model: 'Gemini 3.5 Flash' };
    if (model.startsWith('gemini::')) return { provider: 'gemini', model: model.slice('gemini::'.length) };
    return { provider: provider === 'anthropic' ? 'anthropic' : 'openrouter', model };
  }

  /** Run a prompt on a subscription agent (Codex / Gemini) via its host runner. Returns null on any failure. */
  /**
   * Engines known to be out of quota, and when they come back (BEA-1201).
   *
   * Codex refused every call from 30 July to 28 August. Without this, each attempt spends nine
   * seconds rediscovering that — on every hop, of every job, for a month.
   */
  async engineLimit(provider: string): Promise<{ until: Date | null; reason: string } | null> {
    const row = await this.prisma.setting?.findUnique({ where: { key: `engine.limit.${provider}` } }).catch(() => null);
    if (!row?.value) return null;
    try {
      const v = JSON.parse(row.value);
      const until = v.until ? new Date(v.until) : null;
      if (until && until.getTime() < Date.now()) return null; // it has reset
      return { until, reason: String(v.reason || '').slice(0, 200) };
    } catch { return null; }
  }

  private async markEngineLimited(provider: string, reason: string): Promise<void> {
    // The message carries the reset time ("try again at Aug 28th, 2026 2:55 AM"). Read it when we
    // can; otherwise assume an hour, so a transient rate-limit is not treated as a month-long outage.
    // "Aug 28th, 2026 2:55 AM" — the ordinal suffix alone makes Date.parse return NaN, which would
    // quietly downgrade a month-long outage to a one-hour guess.
    const m = /try again at ([^.)]+)/i.exec(reason)?.[1]?.trim().replace(/(\d+)(st|nd|rd|th)\b/i, '$1');
    const parsed = m ? Date.parse(m) : NaN;
    const until = Number.isFinite(parsed) ? new Date(parsed) : new Date(Date.now() + 3600_000);
    const value = JSON.stringify({ until: until.toISOString(), reason: reason.slice(0, 300) });
    await this.prisma.setting?.upsert({ where: { key: `engine.limit.${provider}` }, create: { key: `engine.limit.${provider}`, value }, update: { value } }).catch(() => undefined);
    this.log.warn(`${provider} is out of quota until ${until.toISOString()} — skipping it until then`);
  }

  private async runAgent(cfg: LlmConfig, prompt: string, label = 'agent'): Promise<string | null> {
    // Don't spend nine seconds rediscovering a limit we already know about.
    if (await this.engineLimit(cfg.provider)) return null;
    try {
      const url = cfg.provider === 'codex' ? CODEX_RUNNER : cfg.provider === 'claude' ? CLAUDE_RUNNER : GEMINI_RUNNER;
      // For Gemini, cfg.model carries the specific Antigravity model name (e.g. "Gemini 3.5 Flash").
      const model = cfg.provider === 'gemini' && cfg.model && cfg.model !== 'gemini' ? cfg.model : undefined;
      const r = await fetch(`${url}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, model }),
        signal: AbortSignal.timeout(190_000),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok) {
        // The runner now reports the REAL reason (BEA-1201). A usage limit is not a blip — it lasts
        // days — so remember it, skip this engine until it resets, and let Settings say so. Its own
        // /status only checks that the binary exists and is signed in, so it happily reports a green
        // light on an engine that refuses every call. That false green is what this issue is about.
        const why = String(d?.error || '');
        if (/usage limit|rate limit|quota/i.test(why)) await this.markEngineLimited(cfg.provider, why);
        return null;
      }
      const text = String(d?.text || '').trim() || null;
      // Record what the turn cost (BEA-1204). Without this the budget can see an engine turn only
      // while it is running: the reservation lifts on return and nothing is left in the usage log,
      // so the traffic that actually emptied the subscription stays invisible. When the runner does
      // not report usage, charge the measured average rather than nothing.
      if (text) {
        const t = TokenBudgetService.tokensOf(d?.usage);
        await this.logUsage(label, cfg.model || cfg.provider, { prompt_tokens: t.prompt, completion_tokens: t.completion }).catch(() => undefined);
      }
      return text;
    } catch {
      return null;
    }
  }

  /**
   * Like completeWith, but also reports which model ACTUALLY produced the text — so a feature that
   * records its engine (e.g. the Story of the Day) shows the truth after an agent→Sonnet fallback.
   */
  async completeWithModel(cfg: LlmConfig | null, prompt: string, maxTokens = 400, label = 'other'): Promise<{ text: string | null; model: string | null; provider?: string; flatRate?: boolean }> {
    if (!cfg?.provider || !cfg?.model) return { text: null, model: null };
    if (isFlatRate(cfg.provider)) {
      // Charged up front like any engine turn — it reports nothing until it finishes (BEA-1204).
      // RESERVED too, not merely checked: two turns starting together would otherwise read the same
      // figure and both be allowed through.
      await this.budget?.require(ENGINE_TURN_TOKENS);
      const release = this.budget?.reserve(ENGINE_TURN_TOKENS) ?? (() => undefined);
      try {
        // Walk the same chain as completeWith (BEA-1201). This used to try one engine and drop
        // straight to the paid model, so the Story of the Day, the Gmail brief and the research
        // write-up never saw the other free engines at all.
        const start = ENGINE_CHAIN.findIndex((e) => e.provider === cfg.provider);
        for (let i = Math.max(0, start); i < ENGINE_CHAIN.length; i++) {
          const e = ENGINE_CHAIN[i];
          const use = i === start ? cfg : e;
          const text = await this.runAgent(use, prompt, i === start ? label : `${label}-${e.provider}`);
          if (text) return { text, model: use.model, provider: use.provider, flatRate: true };
          this.log.warn(`${label}: ${use.provider} could not answer — trying the next engine`);
        }
      } finally {
        release();
      }
      const fb = await this.completeWith(AGENT_FALLBACK, prompt, maxTokens, `${label}-fallback`);
      return { text: fb, model: fb ? 'Claude Sonnet 4.6 (fallback)' : cfg.model, provider: 'openrouter', flatRate: false };
    }
    return { text: await this.completeWith(cfg, prompt, maxTokens, label), model: cfg.model, provider: cfg.provider, flatRate: isFlatRate(cfg.provider) };
  }

  /** Single-shot completion forcing a specific provider+model (e.g. the Tasks engine's Sonnet). */
  async completeWith(cfg: LlmConfig | null, prompt: string, maxTokens = 400, label = 'other'): Promise<string | null> {
    if (!cfg?.provider || !cfg?.model) return null;
    // The ceiling is checked BEFORE the call, never after (BEA-1204). A call that would begin past
    // the budget does not begin — which is exactly "finish the step in flight, then start nothing
    // new". A subscription engine turn is charged its measured average up front, because it reports
    // nothing until it finishes.
    const isAgent = isFlatRate(cfg.provider);
    const estimate = isAgent ? ENGINE_TURN_TOKENS : Math.ceil(prompt.length / 4) + maxTokens;
    await this.budget?.require(estimate); // throws TokenBudgetError, which callers surface verbatim
    const release = this.budget?.reserve(estimate) ?? (() => undefined);
    try {
      // Subscription agents (Codex / Gemini) — route to the host runner (no per-call API $). If the
      // runner is down/slow/empty, fall back to the API on Sonnet so the feature never silently dies.
      if (isFlatRate(cfg.provider)) {
        // Walk the chain from wherever this call started (BEA-1201). One engine running dry is an
        // inconvenience; it is only a bill when there is nowhere else to go.
        const start = ENGINE_CHAIN.findIndex((e) => e.provider === cfg.provider);
        for (let i = Math.max(0, start); i < ENGINE_CHAIN.length; i++) {
          const e = ENGINE_CHAIN[i];
          const use = i === start ? cfg : e;
          const text = await this.runAgent(use, prompt, i === start ? label : `${label}-${e.provider}`);
          if (text) return text;
          // EVERY failed hop is logged, including the first. The original guard skipped `i === start`,
          // which is the common case — Codex going dry would have moved silently to Claude and said
          // nothing. That is precisely the invisibility this issue exists to end.
          this.log.warn(`${label}: ${use.provider} could not answer — trying the next engine`);
        }
        // Nothing free was available. This one costs money, so it is labelled as a fallback and the
        // paid call shows up in the usage log under its own name.
        return this.completeWith(AGENT_FALLBACK, prompt, maxTokens, `${label}-fallback`);
      }
      if (cfg.provider === 'anthropic') {
        const c = await this.connectors.get<{ apiKey: string }>('anthropic');
        if (!c?.apiKey) return null;
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
          // Bounded so one stalled model call can't own the whole turn (BEA-1012).
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        await this.logUsage(label, cfg.model, d?.usage, maxTokens); // tokens only — Anthropic doesn't return $ cost
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
          // Bounded so one stalled model call can't own the whole turn (BEA-1012).
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        await this.logUsage(label, cfg.model, d?.usage, maxTokens);
        return d?.choices?.[0]?.message?.content ?? null;
      }
    } catch (e) {
      if (e instanceof TokenBudgetError) throw e; // a budget stop is a real answer, never a silent null
      return null;
    } finally {
      // The real figure is in UsageLog by now (or the call never ran), so the up-front estimate
      // must come back off — otherwise the day is charged twice for the same call.
      release();
    }
    return null;
  }

  /** Vision completion — sends an image with the prompt. OpenRouter (image_url) + Anthropic (base64);
   *  subscription agents / unknown providers fall back to a text-only completion. (BEA-555) */
  async completeImage(cfg: LlmConfig | null, prompt: string, image: { dataUrl: string; mediaType: string; base64: string }, maxTokens = 400, label = 'vision'): Promise<string | null> {
    if (!cfg?.provider || !cfg?.model) return null;
    // Images bypassed the ceiling too (BEA-1204) — checked and reserved, like every other path.
    const imageEstimate = Math.ceil(prompt.length / 4) + maxTokens;
    await this.budget?.require(imageEstimate);
    const releaseImage = this.budget?.reserve(imageEstimate) ?? (() => undefined);
    try {
      return await this.completeImageInner(cfg, prompt, image, maxTokens, label);
    } finally {
      releaseImage();
    }
  }

  private async completeImageInner(cfg: LlmConfig | null, prompt: string, image: { dataUrl: string; mediaType: string; base64: string }, maxTokens = 400, label = 'vision'): Promise<string | null> {
    if (!cfg?.provider || !cfg?.model) return null;
    try {
      if (cfg.provider === 'openrouter') {
        const c = await this.connectors.get<{ apiKey: string }>('openrouter');
        if (!c?.apiKey) return null;
        const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, usage: { include: true }, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image.dataUrl } }] }] }),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        await this.logUsage(label, cfg.model, d?.usage, maxTokens);
        return d?.choices?.[0]?.message?.content ?? null;
      }
      if (cfg.provider === 'anthropic') {
        const c = await this.connectors.get<{ apiKey: string }>('anthropic');
        if (!c?.apiKey) return null;
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } }] }] }),
        });
        if (!r.ok) return null;
        const d: any = await r.json();
        await this.logUsage(label, cfg.model, d?.usage, maxTokens);
        return d?.content?.[0]?.text ?? null;
      }
      // subscription agents or unknown → text-only (no vision); the caller's prompt should still be useful.
      return this.completeWith(cfg, prompt, maxTokens, label);
    } catch {
      return null;
    }
  }

  /** Streaming completion — calls onToken as text arrives, returns the full text. Falls back to non-streaming for Anthropic. */
  async completeStream(cfg: LlmConfig | null, prompt: string, maxTokens: number, onToken: (t: string) => void, label = 'chat'): Promise<string | null> {
    if (!cfg?.provider || !cfg?.model) return null;
    // Chat streams straight to the provider and used to skip the ceiling entirely — the single
    // busiest surface in the app, unbudgeted (BEA-1204). Reserved as well as checked: two chats
    // starting together would otherwise read the same figure and both be let through.
    const streamEstimate = Math.ceil(prompt.length / 4) + maxTokens;
    await this.budget?.require(streamEstimate);
    const releaseStream = this.budget?.reserve(streamEstimate) ?? (() => undefined);
    try {
      return await this.completeStreamInner(cfg, prompt, maxTokens, onToken, label);
    } finally {
      releaseStream();
    }
  }

  private async completeStreamInner(cfg: LlmConfig | null, prompt: string, maxTokens: number, onToken: (t: string) => void, label = 'chat'): Promise<string | null> {
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
        await this.logUsage(label, cfg.model, usage, maxTokens);
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
