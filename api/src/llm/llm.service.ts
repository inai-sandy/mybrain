import { Injectable, Logger } from '@nestjs/common';
import { ConnectorService } from '../connectors/connector.service';
import { PrismaService } from '../prisma/prisma.service';
import { TokenBudgetService, TokenBudgetError, ENGINE_TURN_TOKENS } from './token-budget.service';

/**
 * 'engine' is not a provider you can call — it is the marker meaning "use whatever engine is
 * chosen", resolved by `resolveEngine()` before any call is made (BEA-1236).
 */
export type LlmConfig = { provider: 'anthropic' | 'openrouter' | 'codex' | 'gemini' | 'claude' | 'engine'; model: string };

// Host-side agent runners (subscription-based engines). The container reaches them on the Docker gateway.
/** Ceiling for a single chat completion. Generous enough for a long answer, short enough that a
 *  stalled provider fails fast instead of holding a voice turn open forever. (BEA-1012) */
const LLM_TIMEOUT_MS = 60_000;
const CODEX_RUNNER = process.env.CODEX_RUNNER_URL || 'http://172.18.0.1:8765';
const GEMINI_RUNNER = process.env.GEMINI_RUNNER_URL || 'http://172.18.0.1:8767';
const CLAUDE_RUNNER = process.env.CLAUDE_RUNNER_URL || 'http://172.18.0.1:8768';

/**
 * Every engine the app knows how to talk to. The owner can still PICK any of these by hand in
 * Settings, and "Upgraded my plan — try again" still works for each — they just no longer form an
 * automatic relay.
 */
const KNOWN_ENGINES: LlmConfig[] = [
  { provider: 'codex', model: 'codex' },
  { provider: 'claude', model: 'claude' },
  { provider: 'gemini', model: 'Gemini 3.5 Flash' },
];

/**
 * The automatic chain is Codex, then the API — nothing in between (BEA-1243).
 *
 * It used to be codex → claude → gemini → paid. Three hops, each able to fail slowly, before a
 * model that answers. The owner froze the engine to Codex and upgraded that plan; the honest backup
 * is one named API model that always works, not a tour of subscriptions he isn't maintaining.
 */
const ENGINE_CHAIN: LlmConfig[] = [
  { provider: 'codex', model: 'codex' },
];
/** Flat-rate = any KNOWN engine (a hand-picked Gemini is still free) — not just the automatic chain. */
const isFlatRate = (p?: string) => KNOWN_ENGINES.some((e) => e.provider === p);

/**
 * The fallback is NAMED AND PINNED (BEA-1243). It must never read the app's general model setting —
 * that is a moving target (qwen one morning, kimi the same afternoon), and qwen is the model that
 * returned nothing twice and killed two branches of a real run (BEA-1236).
 */
const AGENT_FALLBACK: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' };
/** The name the OWNER sees in run logs and story credits — friendlier than the raw model id. */
const AGENT_FALLBACK_LABEL = 'Claude Sonnet 5 (fallback)';

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
  /**
   * "Follow whatever engine is chosen" — a REAL value, not `null` (BEA-1236).
   *
   * `null` used to mean both "this helper is not registered" and "this helper follows the engine",
   * and `helperModel()` returned `null` for both. `completeHelper()` then fell through to
   * `this.complete()` — the app's DEFAULT model. So four helpers the Settings screen describes as
   * following the engine were quietly running on whatever the general `llm` setting happened to be,
   * which was `qwen/qwen3.7-max`. Only deep-research escaped, by hardcoding a special case for its
   * own helper name. One ambiguous value, four features silently doing the opposite of what the
   * screen said.
   */
  static readonly FOLLOW_ENGINE: LlmConfig = { provider: 'engine', model: 'engine' };

  static readonly HELPERS: Record<string, LlmConfig | null> = {
    'chat-edit': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' }, // BEA-1094
    'sync-words': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
    'draft': LlmService.FOLLOW_ENGINE,
    'ui-spec': LlmService.FOLLOW_ENGINE,
    // The SPLITTER — the owner's "most important step" (BEA-1244): it divides a request into
    // branches and picks each branch's tool, including how deep to go (BEA-1246). Pinned to Sonnet 5
    // on the API on purpose: it is a short thinking job that must never wait behind engine quota or
    // pay the ~25,000-token system-prompt tax of a CLI turn, and its judgement decides everything
    // downstream. The engine's job starts AFTER the split: collect, merge, summarise, deliver.
    'flow-plan': { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    'draft-check': LlmService.FOLLOW_ENGINE,
    // Deep research makes two very different calls, so it gets two settings (BEA-1206).
    //
    // PLANNING is "write me six search questions" — measured at ~320 tokens in, ~150 out. A small
    // model does that perfectly. Sending it to the subscription engine is worse than wasteful: a CLI
    // call drags roughly 25,000 tokens of its own system prompt along, so a 470-token job would burn
    // fifty times that from the very allowance the writing needs. Free is not free when it spends the
    // thing you are short of.
    'deep-research-plan': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // Reads one team reply and says whether it needs the owner's eyes — tiny in, tiny out, runs on
    // every inbound WhatsApp message, so a small fast model is the right default. (BEA-1213)
    'review-read': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // Fallback translator for AI Radar headlines when the free endpoint fails — a one-line
    // translate job, so the small fast model. (BEA-1311)
    'radar-translate': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // The daily "why it matters" lines under the Radar picks — one batched writing call a
    // day, so it follows the flat-rate engine like the other content jobs. (BEA-1312)
    'radar-why': LlmService.FOLLOW_ENGINE,
    // Writes each contact's weekly character profile — a once-a-week reasoning job over a month of
    // real messages, so Sonnet by default. (BEA-1216)
    'character-profile': { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' },
    // Condenses one daily report into 1–2 lines the moment it arrives — tiny job, Haiku. (BEA-1223)
    'report-summary': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // Files each AI News Daily story into one of eight fixed categories (BEA-1256). Batched ~30 at
    // a time, a sentence in and a category name out — the definition of a small-model job, and the
    // ONLY paid step in the whole news pipeline. Never FOLLOW_ENGINE: a CLI turn would drag ~25,000
    // tokens of system prompt per batch to answer what is essentially a filing question.
    'news-categorise': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // Writes the daily edition — the headline, the 60-second read and a paragraph per category
    // (BEA-1257). This is the heavy writing job, so it FOLLOWS THE ENGINE and runs on the flat rate:
    // the owner's split of labour is that Sonnet decides and Codex delivers. It writes WORDS only,
    // never HTML — the page template is ours (BEA-1261).
    'news-write': LlmService.FOLLOW_ENGINE,
    // Picks the few stories worth a proper dig (BEA-1258). Forty short snippets in, a handful of
    // numbers out — a small-model job, and one that must not queue behind the engine when the
    // edition is already written and waiting on it.
    'news-flag': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // WRITING follows THE engine choice (see engineChoice).
    'deep-research-write': LlmService.FOLLOW_ENGINE,
    // The thinking blocks INSIDE a flow. The owner's rule — "when I choose Codex, it has to run in
    // Codex" — covers these too; they were the steps that reached for qwen and killed two branches
    // of a real run (BEA-1236).
    'flow-node': LlmService.FOLLOW_ENGINE,
    'flow-merge': LlmService.FOLLOW_ENGINE,
    // Kept so an existing saved setting still resolves.
    'deep-research': { provider: 'codex', model: 'codex' },
    // ---- Agent & flow helpers that had NO entry at all (BEA-1248) ----------------------------
    // These five reached `llm.complete()` directly, so they ran on the app's general model — the
    // one setting the owner can change by accident — and could not be pointed anywhere from
    // Settings. Grading was the worst of them: the thing that tells you whether a run was any good
    // was itself running on whatever happened to be selected.
    //
    // Grading judges a long report against up to 12 of the owner's own checks and gates the
    // auto-revise, so it gets a real model rather than the cheapest one. It is a small job by
    // input size, which is why it does NOT follow the engine — a CLI turn drags ~25,000 tokens of
    // its own system prompt along for a ~1,000-token question, on EVERY run.
    'agent-grade': { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    'flow-eval-grade': { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    // Splitting a request into sub-questions is NOT the same job as planning the flow. It is fed
    // only the raw question — no tool catalog, no skills — and returns 2-5 short strings. That is
    // the same shape as 'deep-research-plan', which sits on Haiku for exactly the reason that
    // applies here: an engine turn drags ~25,000 tokens of its own system prompt along for a
    // ~400-token job. 'flow-plan' follows the engine because it really does reason over the whole
    // tool catalog; this one does not.
    'flow-decompose': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    // Fills the arguments of ONE outside-service call from that action's own JSON schema
    // (BEA-1347). The only model call in the whole execution path — the point of that path is that
    // running a connected service costs no engine turn (~118,000 tokens) at all, so this one is
    // small, capped and pinned to Sonnet 5 on the API: it must never queue behind engine quota, and
    // its output is fed straight into a REAL call that creates, sends or changes something.
    'service-args': { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    // Turns a Social agent's fetched items into the named columns the owner asked for, and keeps
    // only the ones that fit a filter like "in India" — no social search has a country filter, so
    // relevance is ours (BEA-1357). It reads real captions and decides what to keep, so a Sonnet-
    // class model on the API; never the engine (a CLI turn's ~25,000-token tax on every batch).
    'social-shape': { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' },
    // Small extraction jobs: a few example inputs, a few durable facts. Haiku is plenty.
    'suggest-evals': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
    'agent-learn': { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' },
  };

  /**
   * THE engine — one choice, and everything engine-shaped follows it.
   *
   * The owner's words: "When I choose the engine Claude, Step 4 and Skills has to run in Claude.
   * When I choose Codex, has to run in Codex." He was right — a separate setting per job was
   * complexity for its own sake. One picker, and the research write-up, skills and agent runs all
   * obey it. The chain below is only ever an automatic fallback when the chosen one is down, which
   * is insurance rather than something to configure.
   */
  async engineChoice(): Promise<LlmConfig> {
    const row = await this.prisma.setting?.findUnique({ where: { key: 'engine.choice' } }).catch(() => null);
    const picked = String(row?.value || '').trim();
    const found = picked ? KNOWN_ENGINES.find((e) => e.provider === picked) : null;
    return found || ENGINE_CHAIN[0];
  }

  async setEngineChoice(provider: string): Promise<LlmConfig> {
    const found = KNOWN_ENGINES.find((e) => e.provider === provider);
    if (!found) throw new Error('Unknown engine');
    await this.prisma.setting?.upsert({ where: { key: 'engine.choice' }, create: { key: 'engine.choice', value: provider }, update: { value: provider } }).catch(() => undefined);
    return found;
  }

  async helperModel(key: string): Promise<LlmConfig | null> {
    if (!(key in LlmService.HELPERS)) return null;
    const row = await this.prisma.setting.findUnique({ where: { key: `helper.${key}.llm` } }).catch(() => null);
    if (row) { try { const v = JSON.parse((row as any).value); if (v?.provider && v?.model) return this.resolveEngine(v); } catch { /* fall through */ } }
    return this.resolveEngine(LlmService.HELPERS[key]);
  }

  /** Turn the FOLLOW_ENGINE marker into the engine actually chosen. Every helper goes through here. */
  private async resolveEngine(cfg: LlmConfig | null): Promise<LlmConfig | null> {
    if (cfg?.provider !== 'engine') return cfg;
    return this.engineChoice().catch(() => null);
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

  /**
   * Complete on a helper's own model.
   *
   * A helper that HAS a chosen model never silently runs on a different one (BEA-1248). This used to
   * end `return this.complete(...)` unconditionally — the app's general `llm` setting — so any
   * helper whose model came back empty quietly finished on whatever that setting happened to be.
   * It was `qwen/qwen3.7-max` one morning and `moonshotai/kimi-k3` by the afternoon. Freezing the
   * engine to Codex did nothing for these, because the swap happened below the engine entirely.
   *
   * An engine-following helper still has the engine's OWN backup chain inside `completeWithModel`,
   * so this removes a third, invisible layer — not a real safety net.
   *
   * Only a helper with no model at all falls through to the app default, which is what "no opinion"
   * genuinely means.
   */
  async completeHelper(key: string, prompt: string, maxTokens = 400, label = 'other'): Promise<string | null> {
    const cfg = await this.helperModel(key);
    if (cfg) {
      const { text } = await this.completeWithModel(cfg, prompt, maxTokens, label);
      return text || null;
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
    // 'engine' is the FOLLOW_ENGINE marker, not a model anyone can call. Typed into the "Custom…"
    // box it would be saved as an OpenRouter model id, fail every call, and fall back to the app
    // default without a word — the silence this issue exists to remove (BEA-1236).
    if (model === 'engine') return { ...LlmService.FOLLOW_ENGINE };
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

  /**
   * Forget a stored limit and find out for real (BEA-1237).
   *
   * `runAgent` short-circuits on a stored limit without calling the engine, and the limit only
   * expires when its own `until` passes. Codex was marked out until 28 August — so upgrading the
   * plan would have changed nothing for four weeks, with the app quietly using something else and
   * no way to say why. Clearing alone would be a lie in the other direction, so this makes a real
   * call: if the engine is still limited, the limit comes straight back with the reason.
   */
  async recheckEngine(provider: string): Promise<{ ok: boolean; reason: string | null }> {
    if (!KNOWN_ENGINES.some((e) => e.provider === provider)) throw new Error('Unknown engine');
    await this.prisma.setting?.deleteMany?.({ where: { key: `engine.limit.${provider}` } }).catch(() => undefined);
    const cfg = KNOWN_ENGINES.find((e) => e.provider === provider)!;
    const text = await this.runAgent(cfg, 'Reply with exactly: OK', 'engine-recheck').catch(() => null);
    if (text && text.trim()) return { ok: true, reason: null };
    // runAgent records a genuine refusal itself; read back whatever it learned so the answer here
    // matches what Settings will show a second later.
    const again = await this.engineLimit(provider).catch(() => null);
    return { ok: false, reason: again?.reason || 'it did not answer' };
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
      // Charge what a turn on THIS engine really costs (BEA-1240) — one flat figure charged a Codex
      // turn five times its measured cost and stopped runs that had spent almost nothing.
      const estimate = (await this.budget?.estimateFor(cfg.provider).catch(() => ENGINE_TURN_TOKENS)) ?? ENGINE_TURN_TOKENS;
      await this.budget?.require(estimate);
      const release = this.budget?.reserve(estimate) ?? (() => undefined);
      try {
        // The chosen engine, then the named API — no relay through other subscriptions (BEA-1243).
        // A hand-picked Claude or Gemini is tried AS ITSELF here; only when it cannot answer does
        // the job move to the paid model, loudly.
        const text = await this.runAgent(cfg, prompt, label);
        if (text) return { text, model: cfg.model, provider: cfg.provider, flatRate: true };
        this.log.warn(`${label}: ${cfg.provider} could not answer — falling back to the paid API`);
      } finally {
        release();
      }
      const fb = await this.completeWith(AGENT_FALLBACK, prompt, maxTokens, `${label}-fallback`);
      return { text: fb, model: fb ? AGENT_FALLBACK_LABEL : cfg.model, provider: 'openrouter', flatRate: false };
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
        // The chosen engine, then the named API (BEA-1243). It used to relay codex → claude →
        // gemini before paying — three hops, each able to fail slowly, through subscriptions the
        // owner isn't maintaining. The failure is logged (the silence rule from BEA-1201 stands),
        // and the paid call shows up in the usage log under its own `-fallback` name.
        const text = await this.runAgent(cfg, prompt, label);
        if (text) return text;
        this.log.warn(`${label}: ${cfg.provider} could not answer — falling back to the paid API`);
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
