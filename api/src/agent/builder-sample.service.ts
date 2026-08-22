import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ComposioProvider } from '../tools/composio.provider';
import { ScrapeCreatorsProvider } from '../tools/scrapecreators.provider';
import { WhatsAppProvider } from '../tools/whatsapp.provider';
import { ServiceActionsService, ServiceRunResult } from '../tools/service-actions.service';
import { GatePause } from '../tools/service-gates.service';
import { isReadAction, isRiskyAction, isServiceToolId, parseServiceToolId, ServiceAction, ServiceProvider } from '../tools/service-provider';
import { FieldKind, fieldsOfValue } from '../tools/tool-knowledge.service';
import { tableOf } from '../social/rows';
import { SAMPLE_CAPS, SampleCounter, builderSettingKey, readSampleCounter } from './builder-session';

/**
 * "Look for yourself" — the capped sample call a builder conversation may take (BEA-1370, design:
 * `specs/THINKING-BUILDER.md` §B). When the builder is unsure what a source really returns, one
 * real call answers better than a question to the owner: "Popular Search gave 12 posts, no dates"
 * is a fact a plan can use.
 *
 * The rules this file keeps:
 *  - **The same one code path.** Every sample is `ServiceActionsService.runDetailed()` with
 *    `runKind:'builder'`, `argsPinned:true` — so it writes the ordinary `ToolCall` row (with its
 *    credits), and the know-how card's observed part learns from it with nothing extra.
 *  - **Reads only.** A write, a risky/gated action, or an action we cannot load is REFUSED before any
 *    call, with a plain reason, and no row is written — a builder never earns a gate card. The
 *    decision is the catalog's own: the provider's `readOnly`, the action's `method`, `isReadAction`
 *    and `isRiskyAction` — no second rule book here.
 *  - **Capped per conversation.** `SAMPLE_CAPS` (3 calls, 5 credits) — the counter lives in the same
 *    `Setting` row as the conversation, so it survives a restart and a reset clears it. The counter
 *    is bumped BEFORE the call (a reservation), so two samples in flight cannot both pass the cap.
 *  - **The ceiling applies.** `SocialBudgetService.check()` before the call, exactly like a job.
 *  - **Shown.** Every attempt (success or vendor failure) is one log line in the conversation the
 *    owner reads: `🔎 I tried Instagram · Popular Search (query: home automation) — 12 posts ·
 *    fields: caption, owner, url… · no date field · 1 credit`. Refusals are handed back to the
 *    caller (the builder says it in its own words) and are not lines.
 *
 * `SocialBudgetService` cannot be injected here (SocialModule imports AgentModule), so it registers
 * itself at boot through `setBudget()` — the same seam pattern as `AgentService.setFlowSync()`.
 */

/** One item of the compact view is at most this per cell; a caption is a caption, not a book. */
export const SAMPLE_CELL_CHARS = 700;
/** How many trimmed items the builder is shown. */
export const SAMPLE_ITEMS = 3;
/** How many fields (with kinds) the view carries. */
export const SAMPLE_FIELDS = 40;

export type SampleField = { path: string; kind: FieldKind };

/**
 * What the builder is handed back. ONE shape for every road (this repo compiles with `strict:false`,
 * so a union would not narrow): `ok:true` = a real answer; `ok:false` + `refused:true` = we did not
 * call (caps, not a read, cannot load, ceiling); `ok:false` alone = the vendor answered no.
 */
export type SampleView = {
  ok: boolean;
  actionId: string;
  /** "Instagram · Popular Search" — the service and the action, in the catalog's words. */
  name: string;
  args: Record<string, any>;
  /** Items in the answer (a list's length; 1 for a single record; 0 for nothing). */
  count: number;
  /** The list's key when the answer was a list ("posts"), else undefined. */
  listKey?: string;
  fields: SampleField[];
  /** True when any field is a date — the fact "last 30 days" plans need. */
  hasDate: boolean;
  items: Record<string, any>[];
  credits: number;
  ms: number;
  error?: string;
  notFound?: boolean;
  refused?: boolean;
  /**
   * The `ToolCall` row this look wrote (BEA-1405) — the proof a brief line can point at. Every real
   * call writes one, including the services whose answers are deliberately never kept.
   */
  callId?: string;
  /** The whole saved answer, when this service is one we may keep. Absent for Gmail and the rest. */
  sampleId?: string;
  /** Where the conversation's budget stands AFTER this call. */
  budget: { used: number; calls: number; credits: number; maxCredits: number };
};

/** The seam the daily ceiling reaches us through (see the class comment). */
export type SampleBudget = { check(actionId: string): Promise<{ ok: boolean; spent?: number; ceiling?: number | null; estimate?: number; reason?: string }> };

@Injectable()
export class BuilderSampleService {
  private readonly log = new Logger('BuilderSample');
  private budget: SampleBudget | null = null;
  /** One sample at a time per conversation — the reserve-then-call-then-write is not atomic on its own. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly actions: ServiceActionsService,
    private readonly services: ComposioProvider,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly social?: ScrapeCreatorsProvider,
    private readonly prisma?: PrismaService,
    // The third provider (BEA-1384): WhatsApp reads (list_templates, check_replies…) are
    // sampleable; its sends are risky and refused above like any other write.
    private readonly whatsapp?: WhatsAppProvider,
  ) {}

  /** `SocialBudgetService` hands itself in at boot. Null = no ceiling on this server (tests). */
  setBudget(b: SampleBudget | null) {
    this.budget = b;
  }

  /** The counter as it stands, for a screen or a prompt. */
  async budgetOf(sessionKey: string): Promise<SampleCounter> {
    return readSampleCounter(await this.load(sessionKey));
  }

  /**
   * One sample. Never throws for a reason the builder can be told — every road answers a view.
   * `sessionKey` = `TOP_BUILDER_SESSION` for the top-level builder, the area id for a job builder.
   */
  async sample(sessionKey: string, actionId: string, args: Record<string, any> = {}): Promise<SampleView> {
    const key = String(sessionKey || '').trim();
    // Serialised per conversation: two samples landing together must not both read the same counter
    // and both pass the cap. The chain never rejects (the work is caught below), so one failure
    // cannot wedge the queue.
    const prev = this.queues.get(key) || Promise.resolve();
    const run = prev.then(() => this.sampleNow(key, actionId, args));
    this.queues.set(key, run.catch(() => undefined));
    try {
      return await run;
    } finally {
      if (this.queues.get(key) === run.catch(() => undefined)) this.queues.delete(key);
    }
  }

  private async sampleNow(key: string, actionId: string, args: Record<string, any>): Promise<SampleView> {
    const id = String(actionId || '').trim();
    const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    const state = await this.load(key);
    const counter = readSampleCounter(state);
    // What the owner is SHOWN (the view and the log line) masks secret-named arguments, exactly as the
    // `ToolCall` row does; the call itself gets `given` untouched.
    const shownArgs = maskSecrets(given);
    const refuse = (name: string, why: string): SampleView => this.view({ ok: false, refused: true, actionId: id, name, args: shownArgs, error: why, credits: 0, ms: 0 }, counter);

    if (!key) return refuse(id, 'No builder conversation to charge this sample to.');
    if (!isServiceToolId(id)) return refuse(id || '(no action)', `"${id}" is not an outside-service action, so there is nothing to sample.`);

    // ---- the caps: this conversation's own budget ----------------------------------------------
    if (counter.used >= SAMPLE_CAPS.calls) return refuse(id, this.capText(counter));

    // ---- the action, exactly — and is it a read? ------------------------------------------------
    const p = await this.providerFor(id);
    const action: ServiceAction | null = p?.getAction ? await p.getAction(id).catch(() => null) : null;
    if (!action) return refuse(id, `I could not load "${parseServiceToolId(id)?.action || id}" from the catalog, so I did not try it. Ask me instead.`);
    const service = parseServiceToolId(id)?.service || action.service;
    const name = await this.nameOf(p, action, service);
    const risky = !!action.risky || isRiskyAction(id, service);
    const read = p.readOnly === true || String(action.method || '').toUpperCase() === 'GET' || isReadAction(id, service);
    if (risky) return refuse(name, `I only sample reads — "${action.name}" cannot be undone, so I did not try it. Ask me instead.`);
    if (!read) return refuse(name, `I only sample reads — "${action.name}" changes something, so I did not try it. Ask me instead.`);

    // ---- the credit cap: what this call would probably cost, against what is left ---------------
    const estimate = await this.estimate(id);
    if (counter.credits + estimate > SAMPLE_CAPS.credits) return refuse(name, this.capText(counter, estimate));

    // ---- the daily Social ceiling, like a job ---------------------------------------------------
    if (this.budget?.check) {
      // A guard that cannot answer refuses — the safe direction for a budget.
      const b = await this.budget.check(id).catch(() => ({ ok: false, unknown: true } as any));
      if (b?.unknown) return refuse(name, 'I could not check the daily Social credit ceiling just now, so I did not try it. Ask me instead.');
      if (b && b.ok === false) {
        const spent = Number(b.spent || 0).toLocaleString('en-US');
        const ceiling = b.ceiling === null || b.ceiling === undefined ? '' : ` of ${Number(b.ceiling).toLocaleString('en-US')}`;
        return refuse(name, `The daily Social credit ceiling would be passed (${spent}${ceiling} credits spent today), so I did not try it. Ask me instead.`);
      }
    }

    // ---- reserve the call, then make it -------------------------------------------------------
    const reserved: SampleCounter = { used: counter.used + 1, credits: counter.credits };
    await this.save(key, { ...state, samples: reserved });

    let r: ServiceRunResult;
    try {
      r = await this.actions.runDetailed(id, '', { runKind: 'builder', runId: builderSettingKey(key), args: given, argsPinned: true, label: 'sample' });
    } catch (e: any) {
      // Never a gate card in the builder: the read check above makes this unreachable in practice,
      // and if a provider ever flags a read as risky the owner sees a sentence, not a pause.
      r = { ok: false, error: e instanceof GatePause ? `${action.name} would need your approval, so I did not run it.` : String(e?.message || e) };
    }

    const credits = Number.isFinite(r?.credits) ? Number(r.credits) : 0;
    const view = this.compact(r, id, name, shownArgs, credits, reserved);

    // ---- write it down: the counter and the line the owner sees ------------------------------
    const after = await this.load(key);
    const now = readSampleCounter(after);
    const spent: SampleCounter = { used: Math.max(now.used, reserved.used), credits: now.credits + credits };
    view.budget = this.budgetView(spent);
    // `actionId` on the line: the builder reads which finders this conversation has already looked at (BEA-1375).
    const line = { who: 'ai', kind: 'sample', actionId: id, ok: !!view.ok, text: sampleLine(view), at: new Date().toISOString() };
    await this.save(key, { ...after, log: [...(Array.isArray(after.log) ? after.log : []), line], samples: spent });
    return view;
  }

  // ---- the compact view -----------------------------------------------------------------------

  private compact(r: ServiceRunResult, actionId: string, name: string, args: Record<string, any>, credits: number, counter: SampleCounter): SampleView {
    const shown = r?.serviceName && r?.actionName ? `${r.serviceName} · ${r.actionName}` : name;
    if (!r?.ok) {
      return this.view({ ok: false, actionId, name: shown, args, error: r?.error || 'The call failed.', notFound: !!r?.notFound, credits, ms: r?.ms || 0 }, counter);
    }
    const table = tableOf(r.data);
    const fields = sampleFields(r.data, table.listKey);
    const items = table.rows.slice(0, SAMPLE_ITEMS).map((row) => {
      const o: Record<string, any> = {};
      table.columns.forEach((c, i) => { o[c] = trimCell(row[i]); });
      return o;
    });
    // `callId`/`sampleId` ride through so a brief line can point at the call that proves it (BEA-1405).
    return this.view({ ok: true, actionId, name: shown, args, count: table.itemCount, listKey: table.listKey || undefined, fields, hasDate: fields.some((f) => f.kind === 'date'), items, credits, ms: r.ms || 0, callId: r.callId, sampleId: r.sampleId }, counter);
  }

  private view(v: Partial<SampleView> & { ok: boolean; actionId: string; name: string }, counter: SampleCounter): SampleView {
    return {
      ok: v.ok,
      actionId: v.actionId,
      name: v.name,
      args: v.args || {},
      count: v.count || 0,
      ...(v.listKey ? { listKey: v.listKey } : {}),
      fields: v.fields || [],
      hasDate: !!v.hasDate,
      items: v.items || [],
      credits: v.credits || 0,
      ms: v.ms || 0,
      ...(v.error ? { error: v.error } : {}),
      ...(v.notFound ? { notFound: true } : {}),
      ...(v.refused ? { refused: true } : {}),
      ...(v.callId ? { callId: v.callId } : {}),
      ...(v.sampleId ? { sampleId: v.sampleId } : {}),
      budget: this.budgetView(counter),
    };
  }

  private budgetView(c: SampleCounter) {
    return { used: c.used, calls: SAMPLE_CAPS.calls, credits: c.credits, maxCredits: SAMPLE_CAPS.credits };
  }

  private capText(c: SampleCounter, estimate?: number): string {
    const cost = estimate && estimate > 1 ? ` (this one would cost about ${estimate})` : '';
    return `sample budget used (${Math.min(c.used, SAMPLE_CAPS.calls)} of ${SAMPLE_CAPS.calls} samples · ${c.credits} of ${SAMPLE_CAPS.credits} credits${cost}) — ask me instead`;
  }

  // ---- small helpers --------------------------------------------------------------------------

  private async providerFor(actionId: string): Promise<ServiceProvider> {
    try {
      if (this.social?.owns && (await this.social.owns(actionId))) return this.social as any;
    } catch {
      /* an unreachable second provider must never take the first one down with it */
    }
    try {
      if (this.whatsapp?.owns && this.whatsapp.owns(actionId)) return this.whatsapp as any;
    } catch {
      /* same rule for the third */
    }
    return this.services as any;
  }

  /** "Instagram · Popular Search" — the service's catalog name (cached in the provider), else its slug. */
  private async nameOf(p: ServiceProvider, action: ServiceAction, service: string): Promise<string> {
    const info = p?.getService ? await p.getService(service).catch(() => null) : null;
    const svcName = String(info?.name || '').trim() || (service ? service.charAt(0).toUpperCase() + service.slice(1) : '');
    return svcName ? `${svcName} · ${action.name}` : action.name;
  }

  /** What this action cost last time it succeeded — the same guess the ceiling makes; else 1. */
  private async estimate(actionId: string): Promise<number> {
    try {
      const last = await this.prisma?.toolCall?.findFirst?.({ where: { action: actionId, ok: true, credits: { not: null } }, orderBy: { createdAt: 'desc' }, select: { credits: true } });
      const n = Number(last?.credits);
      return Number.isFinite(n) && n > 0 ? n : 1;
    } catch {
      return 1;
    }
  }

  private async load(sessionKey: string): Promise<any> {
    const key = builderSettingKey(sessionKey);
    const row = await this.prisma?.setting?.findUnique?.({ where: { key } }).catch(() => null);
    try {
      const v = row ? JSON.parse((row as any).value) : null;
      return v && typeof v === 'object' ? v : { log: [] };
    } catch {
      return { log: [] };
    }
  }

  private async save(sessionKey: string, state: any): Promise<void> {
    const key = builderSettingKey(sessionKey);
    const log = Array.isArray(state?.log) ? state.log.slice(-40) : [];
    const value = JSON.stringify({ ...state, log });
    await this.prisma?.setting?.upsert?.({ where: { key }, create: { key, value }, update: { value } }).catch((e: any) => this.log.warn(`could not save the sample counter for ${key}: ${e?.message || e}`));
  }
}

// ---- pure helpers (exported for the tests) -------------------------------------------------------

/** Anything whose NAME says it is a secret — the same rule the flight recorder masks by. */
const SECRET_KEY_RE = /secret|token|password|api[-_ ]?key|credential|private[-_ ]?key/i;

/** The arguments as the owner may see them: secret-named values masked, one level deep. */
export function maskSecrets(args: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(args || {})) out[k] = SECRET_KEY_RE.test(k) ? '••••' : v;
  return out;
}

/**
 * The fields of the answer, with kinds, relative to ONE item when the answer is a list — the
 * know-how card's own walker (`fieldsOfValue`), so a date is a date by the same rule everywhere.
 */
export function sampleFields(data: any, listKey?: string): SampleField[] {
  const all = fieldsOfValue(data, { skipEnvelope: true });
  const prefix = listKey ? `${listKey}[].` : '';
  const inside = prefix ? all.filter((f) => f.path.startsWith(prefix)).map((f) => ({ path: f.path.slice(prefix.length), kind: f.kind })) : all.map((f) => ({ path: f.path, kind: f.kind }));
  const chosen = inside.length ? inside : all.map((f) => ({ path: f.path, kind: f.kind }));
  return chosen.filter((f) => f.kind !== 'object' && f.kind !== 'list').slice(0, SAMPLE_FIELDS);
}

/** One cell of one shown item: text cut at `SAMPLE_CELL_CHARS`, numbers/booleans as they are. */
export function trimCell(v: any): any {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  return s.length > SAMPLE_CELL_CHARS ? `${s.slice(0, SAMPLE_CELL_CHARS - 1)}…` : s;
}

/** `{query:'home automation'}` → `(query: home automation)`; nothing → ''. Values kept short. */
export function argsText(args: Record<string, any>): string {
  const parts = Object.entries(args || {})
    .filter(([k, v]) => !k.startsWith('_') && v !== undefined && v !== null && v !== '')
    .slice(0, 6)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
      return `${k}: ${s.length > 40 ? `${s.slice(0, 39)}…` : s}`;
    });
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * The line the owner sees for one attempt — pure, so it is tested as text:
 *   🔎 I tried Instagram · Popular Search (query: home automation) — 12 posts · fields: caption, owner, url… · no date field · 1 credit
 *   🔎 I tried Instagram · Hashtag Search (hashtag: smarthome) — no luck: Instagram could not do that: not_found (No posts found) · 0 credits
 */
export function sampleLine(view: SampleView): string {
  const head = `🔎 I tried ${view.name}${argsText(view.args)}`;
  const credits = view.credits === 1 ? '1 credit' : `${view.credits} credits`;
  if (!view.ok) return `${head} — no luck: ${plainSentence(view.error || 'the call failed')} · ${credits}`;
  const what = view.count === 0 ? 'nothing came back' : view.listKey ? `${view.count} ${view.listKey.split('.').pop()}` : view.count === 1 ? '1 record' : `${view.count} items`;
  const names = [...new Set(view.fields.map((f) => f.path.split('.')[0]))];
  const fields = names.length ? `fields: ${names.slice(0, 6).join(', ')}${names.length > 6 ? '…' : ''}` : 'no fields to show';
  const dateField = view.fields.find((f) => f.kind === 'date');
  const date = dateField ? `has a date field (${dateField.path})` : 'no date field';
  return `${head} — ${what} · ${fields} · ${date} · ${credits}`;
}

function plainSentence(s: string): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return (t.length > 220 ? `${t.slice(0, 219)}…` : t).replace(/\.$/, '');
}
