import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { ComposioProvider } from './composio.provider';
import { ScrapeCreatorsProvider } from './scrapecreators.provider';
import { ExecuteResult, parseServiceToolId, ServiceAccount, ServiceAction, ServiceProvider } from './service-provider';
import { GatePause, PendingGate, ServiceGatesService } from './service-gates.service';

/**
 * Running one outside-service action — with **no engine turn** (BEA-1347). Design: `specs/TOOLS.md`.
 *
 * The rule this file exists to keep is BEA-1203's: *deciding what to do next earns an engine turn;
 * doing the thing does not*. An engine turn averages 118,000 tokens. Creating a GitHub issue is
 * transformation, not a decision — so the whole path here is:
 *
 *   the splitter already picked the action (a `svc:` id straight out of the one catalog)
 *   → the action's schema is fetched exactly, never searched for
 *   → ONE small capped model call fills the arguments from that schema
 *   → `ServiceProvider.execute()` runs it
 *   → the engine, later, only writes up what came back.
 *
 * **It never falls back to a model answer.** Every failure throws with the real reason, so the step
 * is marked failed. The alternative — letting an unknown tool id fall through to a plain model call
 * — is how `svc:github.delete_a_repository` would come back as a fluent description of a deletion
 * that never happened. For a delete, a merge or a refund that reads as "it happened".
 *
 * Every attempt, success or failure, writes a `ToolCall` row before this returns.
 */

/** A ceiling on the one model call. Filling a form from a schema is a small job, and stays one. */
const ARG_FILL_MAX_TOKENS = 700;
/** How much of the step's input the argument-filler is shown. Enough to write from, never a book. */
const ARG_INPUT_CHARS = 4000;
/** How many of an action's fields go into that prompt. No real action asks for more. */
const MAX_SCHEMA_FIELDS = 40;
/** What we keep of the arguments and the result in the flight recorder. */
const RECORDED_ARGS_CHARS = 4000;
const RECORDED_RESULT_CHARS = 2000;
/** What the step hands downstream. A whole API payload would drown the branch it feeds. */
const OUTPUT_CHARS = 8000;

/** Anything whose NAME says it is a secret is masked before the arguments are written down. */
const SECRET_KEY_RE = /secret|token|password|api[-_ ]?key|credential|private[-_ ]?key/i;

/** Where the call came from, so the flight recorder can point back at it. */
export type ServiceCallContext = {
  runId?: string;
  /** 'flow' | 'agent' | 'chat' */
  runKind?: string;
  agentId?: string;
  nodeId?: string;
  /** The account the flow/agent was configured with, by id or by the owner's own name for it. */
  accountId?: string;
  /** Arguments the owner pinned on the node. Given these, no model call happens at all. */
  args?: Record<string, any>;
  /**
   * The caller filled the form itself (the Social page, BEA-1356): use `args` exactly as given —
   * even when they are empty — and NEVER call the model to fill anything in. Without this, an
   * endpoint whose fields the owner left blank would still earn a model call.
   */
  argsPinned?: boolean;
  /** Extra instructions the owner typed on the step. */
  guidance?: string;
  /** The step's own name, for the live log line. */
  label?: string;
  onLine?: (t: string) => void;
};

/**
 * What one run came to, in a shape a screen can draw (BEA-1356). Optional fields on ONE type — this
 * repo compiles with `strict: false`, so a union would not narrow. `ok:false` carries `error`;
 * `ok:true` carries `data` (the provider's whole answer) and `text` (the same, as the engine path
 * has always read it). `credits` is what the provider charged, when it meters; `outOfCredits` says
 * the provider answered 402, so a screen can point at a top-up instead of showing a refusal.
 */
export type ServiceRunResult = {
  ok: boolean;
  text?: string;
  data?: any;
  error?: string;
  credits?: number;
  ms?: number;
  status?: number;
  outOfCredits?: boolean;
  /** The provider answered "nothing matches" (a search with no results) — see `ExecuteResult.notFound` (BEA-1359). */
  notFound?: boolean;
  actionName?: string;
  serviceName?: string;
};

@Injectable()
export class ServiceActionsService {
  private readonly log = new Logger('ServiceActions');

  /**
   * The gate (BEA-1348). Never optional in effect: when nothing is injected we build one here, so
   * an action that cannot be undone can never slip through because a harness left an argument off.
   * Without a database it finds no permanent release and no approval, and therefore stops — the
   * safe direction.
   */
  private readonly gates: ServiceGatesService;

  constructor(
    private readonly provider: ComposioProvider,
    private readonly llm: LlmService,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly prisma?: PrismaService,
    gates?: ServiceGatesService,
    // The second provider (BEA-1355). An action is routed to it only when it says the id is one
    // of its own — exact ids, never a guess — and everything else goes where it always went.
    private readonly social?: ScrapeCreatorsProvider,
  ) {
    this.gates = gates || new ServiceGatesService(prisma, provider);
  }

  /**
   * Which provider owns this id. Asked per ACTION, not per service, on purpose: both providers can
   * know a service called `github` (Composio's GitHub, and the social provider's GitHub scraping),
   * and only the exact id says which one a step means.
   */
  private async providerFor(actionId: string): Promise<ServiceProvider> {
    try {
      if (this.social?.owns && (await this.social.owns(actionId))) return this.social as any;
    } catch {
      /* an unreachable second provider must never take the first one down with it */
    }
    return this.provider as any;
  }

  /**
   * Run `svc:<service>.<action>` and return what came back, as text for the next step.
   *
   * THROWS on every failure, with a sentence the owner can act on. Never returns a description of
   * what it would have done.
   */
  async run(actionId: string, input: string, ctx: ServiceCallContext = {}): Promise<string> {
    const r = await this.runDetailed(actionId, input, ctx);
    // THROWN, never returned: a returned string on failure would fall through to a plain model
    // call upstream and describe a deletion that never happened.
    if (!r.ok) throw new Error(r.error || 'The step failed.');
    return r.text || '';
  }

  /**
   * The same run, answered as a shape instead of a sentence (BEA-1356) — for a screen that wants
   * the provider's whole answer, the cost and a plain reason it can draw. ONE code path: `run()`
   * above is this plus a throw, so there is still exactly one place that calls `execute()` and
   * writes the `ToolCall` row. A gate still THROWS `GatePause` here — a pause is not a result.
   */
  async runDetailed(actionId: string, input: string, ctx: ServiceCallContext = {}): Promise<ServiceRunResult> {
    const parsed = parseServiceToolId(actionId);
    if (!parsed) return { ok: false, error: `"${actionId}" is not an outside-service step.` };
    const { service } = parsed;
    const say = ctx.onLine || (() => undefined);

    const fail = async (message: string, extra: { args?: any; accountId?: string; ms?: number; gated?: boolean; credits?: number; status?: number; notFound?: boolean } = {}): Promise<ServiceRunResult> => {
      const { status, notFound, ...rec } = extra;
      await this.record({ actionId, service, ok: false, error: message, ...rec }, ctx);
      return { ok: false, error: message, ms: extra.ms, credits: extra.credits, status, outOfCredits: status === 402 || undefined, ...(notFound ? { notFound: true } : {}) };
    };

    const p: ServiceProvider = await this.providerFor(actionId);
    if (!p?.execute) return fail('Outside services are not available on this server.');

    // ---- which account, if any -------------------------------------------------------------
    let info = await p.getService(service).catch(() => null);
    // A connection made a moment ago can still be behind the provider's 5-minute read cache. Ask
    // again with fresh eyes before telling the owner to connect something he just connected.
    if (!info || (!info.accounts?.length && !info.noAuth)) {
      p.refresh?.();
      info = await p.getService(service).catch(() => null);
    }
    if (!info) return fail(`We could not find a service called "${service}". Check it is still in your Tools list at /tools.`);

    const name = info.name || service;
    const accounts = info.accounts || [];
    const active = accounts.filter((a) => String(a.status || '').toUpperCase() === 'ACTIVE');

    if (!info.noAuth && !accounts.length) {
      return fail(`Connect ${name} first — open /tools, connect it, then run this step again.`);
    }
    if (!info.noAuth && !active.length) {
      const how = accounts.map((a) => `${this.who(a)} (${a.status})`).join(', ');
      return fail(`Your ${name} login is not finished yet — ${how}. Open /tools and finish it, then run this step again.`);
    }

    let chosen: ServiceAccount | undefined;
    if (active.length) {
      const want = String(ctx.accountId || '').trim();
      if (want) {
        chosen = active.find((a) => a.id === want) || active.find((a) => this.who(a).toLowerCase() === want.toLowerCase());
        // Never guess. A wrong inbox is worse than a stopped step.
        if (!chosen) return fail(`This step is set to use a ${name} account called "${want}", and there is no such account. You have ${this.listNames(active)}. Pick one on the step.`);
      } else if (active.length === 1) {
        chosen = active[0];
      } else {
        // Several accounts and nothing chosen — the labels, never the raw ids: the label is the
        // owner's own name for an account and the only half of this he can act on.
        return fail(`You have ${active.length} ${name} accounts connected — ${this.listNames(active)}. Say which one this step should use, then run it again.`);
      }
    }

    // ---- the action's schema, fetched exactly ----------------------------------------------
    const action: ServiceAction | null = p.getAction ? await p.getAction(actionId).catch(() => null) : null;
    if (!action) {
      // Two things look the same from here — the action was withdrawn, or the provider could not be
      // reached just now — so the message says both rather than picking the scarier one.
      return fail(`We could not load "${parsed.action}" from ${name} — it may have been withdrawn, or ${name} could not be reached just now. Try again, and pick the tool afresh on the step if it keeps failing.`, { accountId: chosen?.id });
    }

    // ---- the gate: is this one of the ones that cannot be taken back? (BEA-1348) ------------
    // Asked here, before any arguments exist, only to find out whether an answer is already on
    // record. `action.risky` comes from the provider; the rule is re-run on our side too, so a
    // provider that forgot to flag something cannot walk a delete straight past the gate.
    // A provider that says every one of its actions is a read (`readOnly`) is taken at its word:
    // the name rule was tuned for Composio's verb-first slugs, and a path-derived read must never
    // be held. Everything else keeps the belt and braces.
    const mustAsk = p.readOnly === true ? false : await this.gates.mustAsk(actionId, service, action.risky).catch(() => true);
    const approval = mustAsk ? await this.gates.approvalFor(actionId, ctx).catch(() => null) : null;

    // ---- the arguments ---------------------------------------------------------------------
    let args: Record<string, any> = {};
    try {
      // An approved gate carries the EXACT arguments the owner was shown. Re-filling them would
      // mean he approved deleting one branch and a fresh model call chose another.
      const approved = approval?.arguments ? this.parseJson(String(approval.arguments)) : null;
      args = await this.fillArgs(action, input, approved ? { ...ctx, args: approved } : ctx);
    } catch (e: any) {
      return fail(String(e?.message || e), { accountId: chosen?.id, gated: mustAsk });
    }

    // ---- stop and ask ----------------------------------------------------------------------
    if (mustAsk && !approval) {
      const gate: PendingGate = this.gates.build({
        action,
        actionId,
        service,
        serviceName: name,
        args,
        accountId: chosen?.id,
        accountLabel: chosen ? this.who(chosen) : undefined,
        label: ctx.label,
        guidance: ctx.guidance,
        stepInput: input,
      });
      // Written BEFORE the pause, on purpose: a run killed mid-pause still shows that this was
      // tried and what it was going to do. The flight recorder must not need a happy ending.
      await this.record({ actionId, service, ok: false, args, accountId: chosen?.id, gated: true, error: 'Held for your approval — nothing was sent.' }, ctx);
      say(`   ⏸ ${name}: ${action.name} — waiting for your approval (this cannot be undone)`);
      // THROWN, never returned: a returned string would fall through to a plain model call and
      // describe a deletion that never happened.
      throw new GatePause(gate);
    }
    if (approval?.id) await this.gates.markUsed(approval.id).catch(() => undefined);

    // ---- run it ----------------------------------------------------------------------------
    say(`   🔌 ${name}: ${action.name}${chosen ? ` (${this.who(chosen)})` : ''}`);
    const started = Date.now();
    // Typed as one shape on both arms: this repo compiles with `strict: false`, so a union of two
    // object literals does not narrow and every field read after it fails to compile.
    const res: ExecuteResult = await p
      .execute(actionId, args, chosen ? { connectionId: chosen.id } : {})
      .catch((e: any): ExecuteResult => ({ ok: false, error: String(e?.message || e) }));
    const ms = (res as any)?.ms ?? Date.now() - started;

    // The honest cost, when the provider meters calls (BEA-1355): read off ITS answer, never
    // assumed — a cache hit is 0 and is written as 0. Undefined for a provider that does not meter.
    const credits = Number.isFinite(res?.credits) ? Number(res.credits) : undefined;

    if (!res?.ok) {
      // The provider already reads the verdict from the answer's own `successful` field rather than
      // the HTTP status — a failed action still comes back HTTP 200. Its reason is the truth here.
      const why = this.plainReason(res?.error);
      const status = Number.isFinite(res?.status) ? Number(res.status) : undefined;
      const r = await fail(`${name} could not do that: ${why}`, { args, accountId: chosen?.id, ms, gated: mustAsk, credits, status, notFound: !!res?.notFound });
      return { ...r, actionName: action.name, serviceName: name };
    }

    const summary = this.summarise(res.data);
    // `gated` on a real success means "this one had to be approved, and it was" (BEA-1348).
    await this.record({ actionId, service, ok: true, args, accountId: chosen?.id, ms, result: summary, gated: mustAsk, credits }, ctx);
    say(`   ✅ ${name}: ${action.name} — done in ${(ms / 1000).toFixed(1)}s`);
    return {
      ok: true,
      text: `Ran ${name}: ${action.name}${chosen ? ` on ${this.who(chosen)}` : ''}.\n\nWhat came back:\n${summary.slice(0, OUTPUT_CHARS)}`,
      data: res.data,
      credits,
      ms,
      actionName: action.name,
      serviceName: name,
    };
  }

  /**
   * The owner has answered a gate (BEA-1348). One door for both answers, so the flight recorder is
   * written in the same place as every other attempt.
   *
   * A yes only writes down the permission — the step itself is then re-run for real, with the exact
   * arguments that were approved. A no runs nothing and says so; there is no ToolCall for a call
   * that never happened beyond the "held" row already written when it paused.
   */
  async answerGate(gate: PendingGate, answer: string, ctx: ServiceCallContext = {}): Promise<{ approved: boolean; message: string }> {
    const decision = this.gates.readDecision(answer);
    await this.gates.record(gate, decision, ctx);
    if (decision === 'approved') {
      return { approved: true, message: `You said yes — running it now: ${gate.headline}.` };
    }
    const message = `You said no, so nothing was done: ${gate.headline}.`;
    await this.record({ actionId: gate.actionId, service: gate.service, ok: false, args: gate.args, accountId: gate.accountId, gated: true, error: message }, ctx);
    return { approved: false, message };
  }

  // ---- arguments ---------------------------------------------------------------------------

  /**
   * Fill the action's arguments — ONE small model call, and only when there is anything to fill.
   *
   * Three ways out, cheapest first: the owner pinned the arguments on the step; the action takes no
   * arguments at all (`GITHUB_GET_THE_AUTHENTICATED_USER` genuinely takes none); or the one capped
   * call. It is a form-filling job, not a thinking job, which is why it is small and why it is the
   * only model call in this whole path.
   *
   * `completeHelper`, never `complete()` — a bare `complete()` runs on the app's GENERAL model
   * setting, a moving target (`qwen3.7-max` one morning, `kimi-k3` the same afternoon), so the call
   * that decides what a real API call is asked to do would drift wherever that setting drifted.
   */
  private async fillArgs(action: ServiceAction, input: string, ctx: ServiceCallContext): Promise<Record<string, any>> {
    const schema = action.schema || {};
    const props: Record<string, any> = schema.properties || {};
    const names = Object.keys(props);
    const required: string[] = Array.isArray(schema.required) ? schema.required : [];

    const pinned = ctx.args && typeof ctx.args === 'object' && Object.keys(ctx.args).length ? ctx.args : null;
    if (pinned) return this.keepKnown(pinned, names);
    // The caller filled the form itself and left everything blank: that IS the answer. No model.
    if (ctx.argsPinned) return {};
    if (!names.length) return {};

    const fields = names.slice(0, MAX_SCHEMA_FIELDS).map((k) => {
      const f = props[k] || {};
      const type = f.type || (f.anyOf ? 'any' : 'string');
      const desc = String(f.description || f.title || '').replace(/\s+/g, ' ').slice(0, 140);
      return `- ${k} (${type}${required.includes(k) ? ', REQUIRED' : ''})${desc ? `: ${desc}` : ''}`;
    });

    const prompt = [
      `Fill in the arguments for one API call. Reply with ONLY a JSON object — no prose, no code fence.`,
      ``,
      `Action: ${action.name}`,
      action.description ? `What it does: ${String(action.description).replace(/\s+/g, ' ').slice(0, 400)}` : '',
      ``,
      `Fields:`,
      ...fields,
      ``,
      `Rules: use only the fields listed. Leave out any field you do not have a real value for — never invent an id, a name or a number. Copy values from the text below exactly as written.`,
      ctx.guidance ? `\nExtra instructions: ${String(ctx.guidance).slice(0, 500)}` : '',
      ``,
      `The step was given this:`,
      String(input || '').slice(0, ARG_INPUT_CHARS) || '(nothing)',
    ].filter((l) => l !== '').join('\n');

    // Said plainly rather than as a TypeError: some spec harnesses build this with a partial llm.
    if (!this.llm?.completeHelper) throw new Error(`The details for ${action.name} could not be worked out on this server.`);
    const raw = await this.llm
      .completeHelper?.('service-args', prompt, ARG_FILL_MAX_TOKENS, 'service-args')
      .catch((e: any) => { throw new Error(`The details for ${action.name} could not be worked out: ${String(e?.message || e).slice(0, 160)}`); });

    if (!raw || !String(raw).trim()) throw new Error(`The details for ${action.name} could not be worked out, so nothing was sent to ${action.service}.`);
    const parsed = this.parseJson(String(raw));
    if (!parsed) throw new Error(`The details for ${action.name} came back unreadable, so nothing was sent to ${action.service}.`);

    const args = this.keepKnown(parsed, names);
    const missing = required.filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    // An action run with a required field missing either errors at the far end or, worse, does
    // something else. Say what is missing instead — the owner can pin it on the step.
    if (missing.length) throw new Error(`This step does not say what to use for ${missing.join(', ')}, which ${action.name} needs. Add it to the step, then run it again.`);
    return args;
  }

  /** Drop anything the schema does not know about — a hallucinated field is not sent on. */
  private keepKnown(values: Record<string, any>, names: string[]): Record<string, any> {
    if (!names.length) return {};
    const out: Record<string, any> = {};
    for (const k of names) if (values[k] !== undefined && values[k] !== null) out[k] = values[k];
    return out;
  }

  /** A model asked for JSON still sometimes wraps it in a fence or a sentence. Take the object. */
  private parseJson(text: string): Record<string, any> | null {
    const cleaned = text.replace(/```(?:json)?/gi, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const v = JSON.parse(cleaned.slice(start, end + 1));
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  // ---- the flight recorder -----------------------------------------------------------------

  /**
   * Write the `ToolCall` row. Every attempt, success or failure — including the ones that never
   * left the building, because "we tried and stopped" is exactly what the owner needs to see when a
   * step says it could not run.
   *
   * Never throws: a call that really happened must not be reported as failed because our own log
   * could not be written.
   */
  private async record(
    call: { actionId: string; service: string; ok: boolean; args?: any; accountId?: string; ms?: number; result?: string; error?: string; gated?: boolean; credits?: number },
    ctx: ServiceCallContext,
  ): Promise<void> {
    try {
      await this.prisma?.toolCall?.create?.({
        data: {
          runId: ctx.runId || null,
          runKind: ctx.runKind || null,
          agentId: ctx.agentId || null,
          nodeId: ctx.nodeId || null,
          service: call.service,
          action: call.actionId,
          accountId: call.accountId || null,
          arguments: call.args === undefined ? null : this.redact(call.args),
          result: call.result ? call.result.slice(0, RECORDED_RESULT_CHARS) : null,
          ok: !!call.ok,
          error: call.error ? String(call.error).slice(0, 500) : null,
          ms: Number.isFinite(call.ms) ? Math.round(call.ms as number) : null,
          gated: !!call.gated,
          // Null, not 0, when the provider does not meter — 0 means "they charged nothing".
          credits: Number.isFinite(call.credits) ? Math.round(call.credits as number) : null,
        },
      });
    } catch (e: any) {
      this.log.warn(`could not write the ToolCall row for ${call.actionId}: ${e?.message || e}`);
    }
  }

  /**
   * The arguments, as JSON, with anything whose name says it is a secret masked.
   *
   * Some actions really do take a token (`GITHUB_CREATE_OR_UPDATE_A_SECRET_…`), and this log is
   * read by a human. A recorded secret is a secret in the database for ever.
   */
  private redact(args: any): string {
    const walk = (v: any, depth = 0): any => {
      if (!v || typeof v !== 'object' || depth > 4) return v;
      if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) ? '••••' : walk(val, depth + 1);
      return out;
    };
    try {
      return JSON.stringify(walk(args)).slice(0, RECORDED_ARGS_CHARS);
    } catch {
      return String(args).slice(0, RECORDED_ARGS_CHARS);
    }
  }

  // ---- small helpers -----------------------------------------------------------------------

  /**
   * The service's real reason, in a sentence rather than a payload.
   *
   * Providers hand their refusals back as the far end's own JSON — GitHub's 404 arrives as
   * `{"message":"Not Found","documentation_url":"…","status":"404"}`. The reason inside it is
   * exactly right and must be kept; the brackets and the doc link around it are noise on a step's
   * failure line, so the message comes out and the wrapper does not.
   */
  private plainReason(error: any): string {
    const raw = String(error || '').trim() || 'the service refused that call';
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const body = JSON.parse(raw.slice(start, end + 1));
        const msg = body?.message || body?.error?.message || body?.error || body?.detail || body?.errors?.[0]?.message;
        if (msg) {
          const status = body?.status || body?.code;
          const before = raw.slice(0, start).trim();
          return `${before ? `${before} ` : ''}${String(msg)}${status ? ` (${status})` : ''}`.slice(0, 400);
        }
      } catch {
        /* not JSON after all — fall through to the raw text */
      }
    }
    return raw.slice(0, 400);
  }

  /** The owner's own name for an account. Never the raw id — `ca_8Hh…` means nothing to anybody. */
  private who(a: ServiceAccount): string {
    return String(a?.label || '').trim() || 'an unnamed account';
  }

  private listNames(accounts: ServiceAccount[]): string {
    return accounts.map((a) => `"${this.who(a)}"`).join(' and ');
  }

  /** What came back, as readable text. Objects go as pretty JSON; a string stays a string. */
  private summarise(data: any): string {
    if (data === undefined || data === null) return 'Nothing was returned.';
    if (typeof data === 'string') return data;
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }
}
