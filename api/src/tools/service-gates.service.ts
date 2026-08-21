import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ComposioProvider } from './composio.provider';
import { WhatsAppProvider } from './whatsapp.provider';
import { isRiskyAction, parseServiceToolId, ServiceAction, ServiceProvider } from './service-provider';

/**
 * Gates (BEA-1348) — the actions that cannot be taken back stop and ask first. Design: `specs/TOOLS.md`.
 *
 * The owner chose **full access with gates**: a connected service exposes everything, normal writes
 * (create an issue, comment, send a message, change a field) run with no friction at all, and only
 * the things that cannot be undone pause. His own measure of success is that he sees a gate "maybe
 * once a week, so I'll actually read it instead of tapping through" — so an implementation that
 * gates too much has failed even if every test passes. WHAT is gated is decided in exactly one
 * place, `isRiskyAction()` in `service-provider.ts`; there is no second rule set here.
 *
 * The pause itself is the DURABLE one (BEA-795 / Move B): the run is written to the database as
 * waiting, with the question and the exact arguments the owner was shown, and nothing is held in
 * memory. It survives a restart, and it is answerable days later. It is never a timeout.
 */

/** Everything needed to ask the question and, later, to run exactly what was agreed to. */
export type PendingGate = {
  /** `svc:github.delete_a_repository` */
  actionId: string;
  service: string;
  /** "GitHub" */
  serviceName: string;
  /** "Delete a repository" */
  actionName: string;
  /**
   * The arguments as they stood when the gate fired — what the owner is shown, and what runs.
   *
   * Kept RAW, unlike the flight recorder's copy: the whole point of an approval is that the step
   * re-runs with exactly what was agreed to, and a masked value would be sent as `••••`. Only the
   * question the owner reads has its secret-looking fields masked.
   */
  args: Record<string, any>;
  /** Which connected account it would run on. */
  accountId?: string;
  accountLabel?: string;
  /** One line: what it would do, to what. */
  headline: string;
  /** The whole thing in plain English, as shown on the waiting card. */
  question: string;
};

/**
 * Thrown by `ServiceActionsService.run()` when an action must stop and ask.
 *
 * NOT a return value, and that is the point: an `svc:` id is not in `AGENT_TOOLS`, so a returned
 * string falls through to `askModel()` and hands back an invented result — for a delete or a
 * refund, one that reads as "it happened". The flow runner catches this and turns it into the
 * durable pause; any other caller sees a normal failure with an honest message.
 */
export class GatePause extends Error {
  constructor(public readonly gate: PendingGate) {
    super(`Held for your approval — ${gate.headline}. Nothing was sent to ${gate.serviceName}.`);
    this.name = 'GatePause';
  }
}

/** Keys worth naming in the question, in the order a person would say them. */
const NAMING_KEYS = ['owner', 'org', 'organization', 'repo', 'repository', 'branch', 'ref', 'channel', 'channel_id', 'project', 'team', 'workspace', 'name', 'title', 'username', 'user', 'user_id', 'email', 'path', 'file', 'id', 'issue_number', 'pull_number', 'number', 'customer', 'subscription'];
const SECRET_KEY_RE = /secret|token|password|api[-_ ]?key|credential|private[-_ ]?key/i;
/** How much of an argument's value is shown. A whole file body is not a question. */
const VALUE_CHARS = 80;
const MAX_SHOWN_ARGS = 6;

@Injectable()
export class ServiceGatesService {
  private readonly log = new Logger('ServiceGates');

  constructor(
    // Optional + LAST — spec files build the services around this one positionally.
    private readonly prisma?: PrismaService,
    private readonly provider?: ComposioProvider,
    // WhatsApp's gated sends live on its own provider (BEA-1384) — the general one blocks the
    // whole service, so `listForService('whatsapp')` must read the list from here.
    private readonly whatsapp?: WhatsAppProvider,
  ) {}

  // ---- the decision -------------------------------------------------------------------------

  /** Does this action stop and ask? The rule, then the owner's own permanent release. */
  async mustAsk(actionId: string, service: string, risky?: boolean): Promise<boolean> {
    if (!(risky || isRiskyAction(actionId, service))) return false;
    return !(await this.isReleased(service, actionId));
  }

  /** True when the owner turned this gate off for good from /tools. */
  async isReleased(service: string, actionId: string): Promise<boolean> {
    const row = await this.prisma?.serviceGate
      ?.findFirst?.({ where: { service, action: actionId, scope: 'always' } })
      .catch(() => null);
    return !!row;
  }

  /**
   * The owner's unspent "yes" for this exact step, if there is one.
   *
   * Keyed on the run AND the step, so a yes is spent once: approving a delete in one run can never
   * silently approve the same delete in tomorrow's run.
   */
  async approvalFor(actionId: string, ctx: { runId?: string; nodeId?: string }): Promise<any | null> {
    if (!ctx?.runId || !ctx?.nodeId) return null;
    return (
      (await this.prisma?.serviceGate
        ?.findFirst?.({ where: { action: actionId, runId: ctx.runId, nodeId: ctx.nodeId, scope: 'once', decision: 'approved', usedAt: null }, orderBy: { createdAt: 'desc' } })
        .catch(() => null)) || null
    );
  }

  /** Write down the owner's answer. The arguments travel with a yes so the re-run cannot drift. */
  async record(gate: PendingGate, decision: 'approved' | 'rejected', ctx: { runId?: string; nodeId?: string }): Promise<void> {
    await this.prisma?.serviceGate
      ?.create?.({
        data: {
          service: gate.service,
          action: gate.actionId,
          scope: 'once',
          runId: ctx?.runId || null,
          nodeId: ctx?.nodeId || null,
          decision,
          arguments: decision === 'approved' ? this.safeJson(gate.args) : null,
          question: (gate.question || '').slice(0, 1000),
        },
      })
      .catch((e: any) => this.log.warn(`could not write the gate decision for ${gate.actionId}: ${e?.message || e}`));
  }

  /** Spend a one-time yes, so it can never approve a second run. */
  async markUsed(id: string): Promise<void> {
    if (!id) return;
    await this.prisma?.serviceGate?.update?.({ where: { id }, data: { usedAt: new Date() } }).catch(() => undefined);
  }

  /**
   * Read the owner's answer. Anything that is not plainly a yes is a no — the whole point of a gate
   * is that "hm not sure" must never delete a repository.
   */
  readDecision(answer: string): 'approved' | 'rejected' {
    const t = String(answer || '').trim().toLowerCase();
    if (!t) return 'rejected';
    if (/^(no|n|stop|cancel|don'?t|do not|reject|deny)\b/.test(t)) return 'rejected';
    return /^(y|yes|ok|okay|go|run|do it|approve|allow|confirm|sure|proceed)\b/.test(t) ? 'approved' : 'rejected';
  }

  /** What the waiting card offers. Two buttons — a third one saying "always" is a tap-through. */
  readonly options = ['Yes, run it', 'No, stop'];

  // ---- the question -------------------------------------------------------------------------

  /**
   * The question the owner reads. Plain English, and it names the REAL consequence with the REAL
   * target — "Delete a repository on GitHub — inai-sandy/mybrain? This cannot be undone." — plus
   * what the step was trying to achieve. Never "Allow this action?".
   */
  build(input: {
    action: ServiceAction;
    actionId: string;
    service: string;
    serviceName: string;
    args: Record<string, any>;
    accountId?: string;
    accountLabel?: string;
    /** The step's own name, and what it was handed — "what the agent was trying to achieve". */
    label?: string;
    guidance?: string;
    stepInput?: string;
  }): PendingGate {
    const target = this.target(input.args);
    const name = input.action?.name || parseServiceToolId(input.actionId)?.action?.replace(/_/g, ' ') || 'this action';
    const headline = `${name} on ${input.serviceName}${target ? ` — ${target}` : ''}`;
    const details = this.details(input.args);
    const why = this.why(input.label, input.guidance, input.stepInput);

    const lines = [
      `${headline}? This cannot be undone.`,
      '',
      details ? `It will run with: ${details}` : 'It takes no details.',
      input.accountLabel ? `Account: ${input.accountLabel}` : '',
      why ? `Why: ${why}` : '',
      '',
      'Say yes and I will run it. Say no and I will stop and the run carries on without it.',
    ].filter((l, i, all) => !(l === '' && all[i - 1] === ''));

    return {
      actionId: input.actionId,
      service: input.service,
      serviceName: input.serviceName,
      actionName: name,
      args: input.args || {},
      accountId: input.accountId,
      accountLabel: input.accountLabel,
      headline,
      question: lines.join('\n').trim(),
    };
  }

  /** "inai-sandy/mybrain", "#general", "sandy@kiot.io" — the thing this would happen to. */
  private target(args: Record<string, any>): string {
    const a = args || {};
    const val = (k: string) => (a[k] === undefined || a[k] === null || a[k] === '' ? '' : String(a[k]).slice(0, VALUE_CHARS));
    const owner = val('owner') || val('org') || val('organization');
    const repo = val('repo') || val('repository');
    if (owner && repo) return `${owner}/${repo}`;
    for (const k of NAMING_KEYS) {
      const v = val(k);
      if (v && !SECRET_KEY_RE.test(k)) return v;
    }
    return '';
  }

  /** Every argument that matters, as `key = value`, with anything named like a secret masked. */
  private details(args: Record<string, any>): string {
    const entries = Object.entries(args || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (!entries.length) return '';
    return entries
      .slice(0, MAX_SHOWN_ARGS)
      .map(([k, v]) => `${k} = ${SECRET_KEY_RE.test(k) ? '••••' : this.short(v)}`)
      .join(', ');
  }

  private short(v: any): string {
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
    const one = String(s).replace(/\s+/g, ' ').trim();
    return one.length > VALUE_CHARS ? `${one.slice(0, VALUE_CHARS)}…` : one;
  }

  private why(label?: string, guidance?: string, stepInput?: string): string {
    const step = String(label || '').trim();
    const wants = String(guidance || '').trim() || String(stepInput || '').replace(/\s+/g, ' ').trim();
    const clipped = wants.slice(0, 240) + (wants.length > 240 ? '…' : '');
    if (step && clipped) return `the step "${step}" is working on: ${clipped}`;
    if (step) return `the step "${step}" asked for it`;
    return clipped ? `the run is working on: ${clipped}` : '';
  }

  private safeJson(v: any): string {
    try { return JSON.stringify(v ?? {}); } catch { return '{}'; }
  }

  // ---- release permanently (/tools → Manage) -------------------------------------------------

  /**
   * The gated actions of one service, and which of them the owner has released.
   *
   * Read from the FULL action list — the same one the catalog is built from since BEA-1354 — because
   * every action an agent can pick is one that can pause, and a gate the owner cannot see is a gate
   * he cannot release. Any action released earlier is listed too, even if it has since disappeared
   * from the vendor's list.
   */
  async listForService(slug: string): Promise<{ service: string; actions: { id: string; name: string; description?: string; released: boolean; retired?: boolean }[] }> {
    const service = String(slug || '').toLowerCase();
    const p: ServiceProvider = (service === 'whatsapp' && this.whatsapp ? this.whatsapp : this.provider) as any;
    const actions: ServiceAction[] = p?.listActions ? await p.listActions(service).catch(() => [] as ServiceAction[]) : [];
    const releasedRows = (await this.prisma?.serviceGate?.findMany?.({ where: { service, scope: 'always' } }).catch(() => [])) || [];
    const released = new Set<string>(releasedRows.map((r: any) => r.action));

    // Retired actions are listed too (BEA-1365) — tagged, and after the live ones: a retired
    // action can still be picked, so it can still pause.
    const out = actions
      .filter((a) => a.risky || isRiskyAction(a.id, service))
      .map((a) => ({ id: a.id, name: a.name, description: a.description, released: released.has(a.id), ...(a.retired ? { retired: true } : {}) }));

    for (const id of released) {
      if (out.some((a) => a.id === id)) continue;
      const bare = parseServiceToolId(id)?.action?.replace(/_/g, ' ') || id;
      out.push({ id, name: bare.charAt(0).toUpperCase() + bare.slice(1), description: '', released: true });
    }
    return { service, actions: out.sort((a, b) => Number(!!a.retired) - Number(!!b.retired) || a.name.localeCompare(b.name)) };
  }

  /** Turn this gate off for good — for the service, never per agent. */
  async release(actionId: string): Promise<{ ok: boolean; message?: string }> {
    const parsed = parseServiceToolId(actionId);
    if (!parsed) return { ok: false, message: `"${actionId}" is not an outside-service action.` };
    if (await this.isReleased(parsed.service, actionId)) return { ok: true, message: 'That one was already released.' };
    await this.prisma?.serviceGate?.create?.({ data: { service: parsed.service, action: actionId, scope: 'always', decision: 'approved' } });
    this.log.log(`gate released permanently: ${actionId}`);
    return { ok: true, message: 'It will run without asking from now on.' };
  }

  /** Put the gate back. */
  async restore(actionId: string): Promise<{ ok: boolean; message?: string }> {
    const parsed = parseServiceToolId(actionId);
    if (!parsed) return { ok: false, message: `"${actionId}" is not an outside-service action.` };
    await this.prisma?.serviceGate?.deleteMany?.({ where: { service: parsed.service, action: actionId, scope: 'always' } });
    this.log.log(`gate restored: ${actionId}`);
    return { ok: true, message: 'It will stop and ask again.' };
  }
}
