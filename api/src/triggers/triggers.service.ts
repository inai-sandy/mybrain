import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { FlowRunnerService } from '../flows/flows-runner.service';
import { TelegramService } from '../telegram/telegram.service';
import { ComposioProvider } from '../tools/composio.provider';
import { EventDelivery, isServiceEventId, parseServiceEventId, ServiceProvider, ServiceTrigger } from '../tools/service-provider';
import { findEcho, ToolCallRow } from './echo-guard';

/**
 * Triggers (BEA-1350) — a service event starts a flow. Design: `specs/TOOLS.md` → Triggers.
 *
 * The other direction of everything built so far. An agent acts when it is poked or when a clock
 * goes off; this is the service saying "it just happened" and a flow waking up to deal with it.
 *
 * Three things hold the whole feature up, and none of them are optional:
 *
 *  - **The webhook is public and the secret is the only door.** It has to be, because the provider
 *    posts to it with no session of ours. The secret lives in the URL we hand the provider and is
 *    compared in constant time; a request without it never reaches a binding, let alone a flow.
 *  - **The echo guard** (`echo-guard.ts`) drops the events we caused ourselves, so an agent posting
 *    to Slack cannot wake the flow that makes it post again.
 *  - **The rate cap** pauses a binding that fires more than its allowance in an hour, says why, and
 *    tells the owner. A rule that has started misbehaving must never keep going quietly.
 *
 * And one rule about what a trigger-started run IS: **nobody is watching it.** It uses the durable
 * pause in `flows-runner` (BEA-795/1348) like any background run, never Chat's inline confirm card.
 * The gates themselves are untouched — `ServiceGatesService` decides, `isRiskyAction()` is the only
 * rule, and there is no second rule set here.
 */

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://mybrain.1site.ai';

/** Where the provider posts events. The secret is the last segment. */
const WEBHOOK_PATH = '/api/tools/triggers/events';

/** The setting keys. The secret is ours; the signing secret is the provider's. */
const SECRET_KEY = 'triggers.secret';
const SIGNING_KEY = 'triggers.signingSecret';

/** Runs an hour, per binding, before it pauses itself. */
export const DEFAULT_RATE_CAP = 20;

/**
 * How far back the echo guard looks, in minutes.
 *
 * An instant event arrives in seconds; a polled one can be a whole interval late plus the provider's
 * own jitter, so the window is built from the event's own interval rather than a guess. Short on
 * purpose — see `echo-guard.ts` for why a long window would drop real events.
 */
const ECHO_MIN_MINUTES = 5;
const ECHO_MAX_MINUTES = 30;

/** How many recent calls of that service the guard is shown. Far more than a real minute produces. */
const ECHO_CALL_LIMIT = 60;

/** What we keep of one event in the history, so a binding's log cannot become a payload store. */
const KEPT_PAYLOAD_CHARS = 4000;
/** What the woken flow is handed. */
const RUN_INPUT_CHARS = 6000;
/** How many events one binding keeps. Older ones are trimmed as new ones land. */
const HISTORY_PER_BINDING = 200;

/** Keys worth putting in the one-line summary of an event, in the order a person would read them. */
const SUMMARY_KEYS = ['title', 'subject', 'name', 'text', 'message', 'body', 'summary', 'full_name', 'html_url', 'url', 'identifier', 'action'];

export type TriggerEventInput = {
  body: any;
  /** The secret out of the URL (or the header), exactly as it arrived. */
  secret?: string;
};

@Injectable()
export class TriggersService {
  private readonly log = new Logger('Triggers');

  /** One in-flight chain per binding, so a rule's own events cannot overtake each other. */
  private readonly queues = new Map<string, Promise<any>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: ComposioProvider,
    private readonly runner: FlowRunnerService,
    // Optional + LAST — spec files build this positionally with fewer args.
    private readonly telegram?: TelegramService,
  ) {}

  // ---- the address events arrive at --------------------------------------------------------

  /** Our own secret for the webhook, made once and kept. Mirrors the documents ingest token. */
  async secret(): Promise<string> {
    const existing = await this.getSetting(SECRET_KEY);
    if (existing) return existing;
    const made = randomBytes(24).toString('hex');
    await this.setSetting(SECRET_KEY, made);
    return made;
  }

  /** Constant-time, and a missing secret is always a no — never "nothing set, so let it through". */
  async verifySecret(provided?: string | null): Promise<boolean> {
    const stored = await this.getSetting(SECRET_KEY);
    if (!stored || !provided) return false;
    const a = Buffer.from(String(stored));
    const b = Buffer.from(String(provided));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async webhookUrl(): Promise<string> {
    return `${PUBLIC_URL}${WEBHOOK_PATH}/${await this.secret()}`;
  }

  /**
   * Make sure the provider is posting events to us, and remember what it signs them with.
   *
   * Called whenever a binding is switched on, not once at boot: the provider allows one delivery
   * address per account, and this is the moment it actually matters that ours is the one set.
   */
  async ensureDelivery(): Promise<{ ok: boolean; url?: string; message?: string }> {
    const p: ServiceProvider = this.provider as any;
    const url = await this.webhookUrl();
    if (!p?.ensureEventDelivery) return { ok: false, message: 'This server cannot receive service events.' };
    // Typed as ONE shape on both arms: this repo compiles with `strict: false`, so a union of two
    // object literals does not narrow and every field read after it fails to compile.
    const r: EventDelivery = await p.ensureEventDelivery(url).catch((e: any): EventDelivery => ({ ok: false, message: String(e?.message || e) }));
    if (r?.ok && r.signingSecret) await this.setSetting(SIGNING_KEY, r.signingSecret).catch(() => undefined);
    return { ok: !!r?.ok, url, message: r?.message };
  }

  /**
   * What the page shows about the plumbing itself.
   *
   * The address is **masked**, because the secret IS the last segment of it. Nothing needs the real
   * one — the app hands it to the provider itself — and a URL printed on a screen is a URL in a
   * screenshot. The owner only needs to know that events have somewhere to arrive.
   */
  async status(): Promise<{ ready: boolean; url: string; message?: string }> {
    // Provisions the secret if this is the first time anyone has asked, so the address exists from
    // the moment it is looked at rather than appearing halfway through making the first rule.
    await this.secret();
    const signing = await this.getSetting(SIGNING_KEY);
    return { ready: !!signing, url: `${PUBLIC_URL}${WEBHOOK_PATH}/••••••` };
  }

  // ---- what a service can tell us about ----------------------------------------------------

  /**
   * The events one service offers. **A connected service may have none at all** — Sentry and Vercel
   * both have zero — so an empty list is an answer, not a failure, and the caller says so plainly
   * rather than drawing an empty picker.
   */
  async available(service: string): Promise<{ service: string; triggers: ServiceTrigger[] }> {
    const slug = String(service || '').toLowerCase();
    const p: ServiceProvider = this.provider as any;
    const triggers = p?.listTriggers ? await p.listTriggers(slug).catch(() => [] as ServiceTrigger[]) : [];
    return { service: slug, triggers };
  }

  // ---- the bindings ------------------------------------------------------------------------

  /** The owner's rules, newest first, with the flow each one starts and how it has been doing. */
  async list(service?: string): Promise<{ bindings: any[] }> {
    const where = service ? { service: String(service).toLowerCase() } : {};
    const rows = (await this.prisma.triggerBinding?.findMany?.({ where, orderBy: { createdAt: 'desc' } }).catch(() => [])) || [];
    const flowIds = [...new Set(rows.map((r: any) => r.flowId).filter(Boolean))];
    const flows = flowIds.length ? (await this.prisma.flow?.findMany?.({ where: { id: { in: flowIds } } }).catch(() => [])) || [] : [];
    const names = new Map<string, string>(flows.map((f: any) => [f.id, f.name]));
    const out: any[] = [];
    for (const r of rows as any[]) {
      out.push({ ...this.shape(r), flowName: names.get(r.flowId) || null, ranLastHour: await this.runsInLastHour(r.id) });
    }
    return { bindings: out };
  }

  /**
   * Make a rule: when this happens, run that flow.
   *
   * The subscription at the provider is created FIRST and the row is written only if that worked —
   * the other way round leaves a rule the owner can see and nothing listening behind it.
   */
  async create(input: { service?: string; triggerType?: string; flowId?: string; config?: Record<string, any>; accountId?: string; label?: string; rateCap?: number }): Promise<{ ok: boolean; binding?: any; message?: string }> {
    const triggerType = String(input?.triggerType || '');
    const parsed = parseServiceEventId(triggerType);
    if (!parsed) return { ok: false, message: 'Pick an event first.' };
    const service = String(input?.service || parsed.service).toLowerCase();
    if (service !== parsed.service) return { ok: false, message: 'That event does not belong to this service.' };
    const flowId = String(input?.flowId || '').trim();
    if (!flowId) return { ok: false, message: 'Pick the flow this should start.' };
    const flow = await this.prisma.flow?.findUnique?.({ where: { id: flowId } }).catch(() => null);
    if (!flow) return { ok: false, message: 'We could not find that flow. Pick it again.' };

    const delivery = await this.ensureDelivery();
    if (!delivery.ok) return { ok: false, message: delivery.message || 'We could not set up the address events are sent to.' };

    const made = await this.startListening(triggerType, input?.config || {}, input?.accountId);
    if (!made.ok) return { ok: false, message: made.message };

    // If our own write fails now, the subscription at the provider exists and NOTHING points at it —
    // the exact orphan this whole feature is careful about, reached from the other side. So it is
    // taken back down before we admit defeat.
    try {
      const row = await this.prisma.triggerBinding.create({
        data: {
          service,
          triggerType,
          triggerInstanceId: made.instanceId || null,
          flowId,
          config: JSON.stringify(input?.config || {}),
          accountId: input?.accountId || null,
          label: String(input?.label || '').trim().slice(0, 120) || null,
          rateCap: this.cap(input?.rateCap),
          enabled: true,
        },
      });
      this.log.log(`listening for ${triggerType} → flow ${flowId}`);
      return { ok: true, binding: this.shape(row) };
    } catch (e: any) {
      await this.undo(made.instanceId, triggerType, e);
      return { ok: false, message: 'We could not save that rule, so nothing is listening. Try again in a moment.' };
    }
  }

  /**
   * Change a rule. Switching it off (or on) is not a flag on a row — it takes the subscription away
   * at the provider, and puts it back. An instance left behind bills the owner for a rule he turned
   * off, which is exactly the orphan this is here to prevent.
   */
  async update(id: string, patch: { enabled?: boolean; rateCap?: number; label?: string; config?: Record<string, any> }): Promise<{ ok: boolean; binding?: any; message?: string }> {
    const row = await this.prisma.triggerBinding?.findUnique?.({ where: { id: String(id || '') } }).catch(() => null);
    if (!row) return { ok: false, message: 'We could not find that rule.' };
    const data: Record<string, any> = {};
    if (patch?.label !== undefined) data.label = String(patch.label || '').trim().slice(0, 120) || null;
    if (patch?.rateCap !== undefined) data.rateCap = this.cap(patch.rateCap);
    if (patch?.config !== undefined) data.config = JSON.stringify(patch.config || {});

    if (patch?.enabled !== undefined && !!patch.enabled !== !!row.enabled) {
      if (patch.enabled) {
        const config = patch?.config !== undefined ? patch.config : this.parse(row.config);
        const made = await this.startListening(row.triggerType, config || {}, row.accountId || undefined);
        if (!made.ok) return { ok: false, message: made.message };
        data.enabled = true;
        data.triggerInstanceId = made.instanceId || null;
        // Switched back on by hand — whatever paused it is dealt with.
        data.pausedReason = null;
      } else {
        const stopped = await this.stopListening(row.triggerInstanceId);
        if (!stopped.ok) return { ok: false, message: stopped.message };
        data.enabled = false;
        data.triggerInstanceId = null;
        data.pausedReason = null;
      }
    }
    try {
      const updated = await this.prisma.triggerBinding.update({ where: { id: row.id }, data });
      return { ok: true, binding: this.shape(updated) };
    } catch (e: any) {
      // Same orphan, same answer: a subscription we just made and cannot record must not survive.
      if (data.triggerInstanceId) await this.undo(data.triggerInstanceId, row.triggerType, e);
      return { ok: false, message: 'We could not save that change, so nothing was changed. Try again in a moment.' };
    }
  }

  /**
   * One rule's events, one at a time.
   *
   * A queue per binding, in memory, because that is all it needs to be: this is one container, and
   * the thing being protected is a read-then-write inside a single process. Different rules still
   * run side by side; only the same rule waits. A failed event never blocks the next one.
   */
  private inOrder<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) || Promise.resolve();
    const next = prev.then(work, work);
    // The stored link never rejects, or one thrown error would poison the queue for ever.
    const settled = next.then(() => undefined, () => undefined);
    this.queues.set(key, settled);
    // And it never grows: the last one out clears its own slot.
    settled.then(() => { if (this.queues.get(key) === settled) this.queues.delete(key); });
    return next;
  }

  /** Take back a subscription we made and then could not record. Never throws — we are already failing. */
  private async undo(instanceId: string | null | undefined, triggerType: string, cause: any): Promise<void> {
    this.log.error(`could not record the ${triggerType} rule (${cause?.message || cause}) — taking the subscription back down`);
    const stopped = await this.stopListening(instanceId).catch(() => ({ ok: false }));
    // Worth shouting about: this is the one path that CAN leave an orphan, and the id is the only
    // way anyone would ever find it again.
    if (!stopped.ok) this.log.error(`the ${triggerType} subscription ${instanceId} is still live at the provider and nothing points at it — remove it by hand`);
  }

  /**
   * Throw a rule away. The subscription goes first: a row deleted while the provider is still
   * sending is the orphan that quietly bills events nobody will ever look at.
   */
  async remove(id: string): Promise<{ ok: boolean; message?: string }> {
    const row = await this.prisma.triggerBinding?.findUnique?.({ where: { id: String(id || '') } }).catch(() => null);
    if (!row) return { ok: true };
    const stopped = await this.stopListening(row.triggerInstanceId);
    if (!stopped.ok) return { ok: false, message: stopped.message };
    await this.prisma.triggerEvent?.deleteMany?.({ where: { bindingId: row.id } }).catch(() => undefined);
    await this.prisma.triggerBinding.delete({ where: { id: row.id } });
    this.log.log(`stopped listening for ${row.triggerType}`);
    return { ok: true };
  }

  /** What has arrived for one rule (or all of them), newest first. */
  async events(bindingId?: string, limit = 50): Promise<{ events: any[] }> {
    const where = bindingId ? { bindingId: String(bindingId) } : {};
    const rows = (await this.prisma.triggerEvent?.findMany?.({ where, orderBy: { createdAt: 'desc' }, take: Math.min(200, Math.max(1, limit)) }).catch(() => [])) || [];
    return { events: rows.map((r: any) => ({ id: r.id, bindingId: r.bindingId, status: r.status, detail: r.detail, runId: r.runId, summary: r.summary, at: r.createdAt })) };
  }

  // ---- an event arrives --------------------------------------------------------------------

  /**
   * One inbound event, from the secret through to a started run.
   *
   * The secret is checked HERE as well as at the door, so there is no path into this method that
   * skips it. Everything after that is written down whatever happens: an event we dropped is as much
   * a part of the record as one that ran, and a binding that looks quiet must be explainable.
   */
  async handle(input: TriggerEventInput): Promise<{ ok: boolean; status: string; message?: string; runId?: string }> {
    if (!(await this.verifySecret(input?.secret))) return { ok: false, status: 'rejected', message: 'That secret is not right.' };

    const event = this.readEvent(input?.body);

    // Not an event about a thing that happened — the provider also tells us when a login has expired
    // or when it has switched a trigger off at its end. Both are worth the owner's attention.
    if (event.kind && event.kind !== 'message') return this.handleNotice(event);

    const binding = await this.bindingFor(event);
    if (!binding) {
      await this.record(null, event, 'ignored', 'No rule is listening for this, so nothing ran.');
      return { ok: true, status: 'ignored' };
    }
    // One rule's events are dealt with ONE AT A TIME (see `inOrder`). The webhook answers before it
    // does the work, so a burst arrives as several overlapping calls, and the rate cap is a
    // read-then-write: without this, three events landing together would each read the same
    // under-the-limit count and all three would run past it.
    return this.inOrder(binding.id, () => this.actOn(binding.id, event));
  }

  /** Everything that happens to one event once we know whose rule it is. Never runs twice at once. */
  private async actOn(bindingId: string, event: any): Promise<{ ok: boolean; status: string; message?: string; runId?: string }> {
    // Read afresh rather than trusting what was fetched before the queue: the event ahead of this
    // one may have been the one that paused the rule, and acting on the old copy would run anyway.
    const binding = await this.prisma.triggerBinding?.findUnique?.({ where: { id: bindingId } }).catch(() => null);
    if (!binding) {
      await this.record(null, event, 'ignored', 'That rule was removed while this event was in the queue, so nothing ran.');
      return { ok: true, status: 'ignored' };
    }
    if (!binding.enabled) {
      await this.record(binding, event, 'ignored', 'This rule is switched off, so nothing ran.');
      return { ok: true, status: 'ignored' };
    }

    // ---- the echo guard --------------------------------------------------------------------
    const echo = findEcho({ triggerType: binding.triggerType, payload: event.payload }, await this.recentCalls(binding));
    if (echo.echo) {
      await this.record(binding, event, 'echo', echo.why, { echoOfId: echo.callId });
      return { ok: true, status: 'echo' };
    }

    // ---- the rate cap ----------------------------------------------------------------------
    const cap = this.cap(binding.rateCap);
    const ran = await this.runsInLastHour(binding.id);
    if (ran >= cap) {
      const reason = `It started ${ran} runs in an hour, which is over its limit of ${cap}, so it stopped listening.`;
      await this.pauseBinding(binding, reason);
      await this.record(binding, event, 'capped', `${reason} Nothing ran for this event.`);
      return { ok: true, status: 'capped', message: reason };
    }

    // ---- run it ----------------------------------------------------------------------------
    try {
      const started = await this.runner.start(binding.flowId, { input: this.runInput(event, binding) });
      await this.prisma.triggerBinding.update({ where: { id: binding.id }, data: { lastFiredAt: new Date() } }).catch(() => undefined);
      if (started?.joined) {
        // Honest, not silent: the flow was already running, so this event joined that run rather
        // than starting a second one (the no-stacking rule, BEA-772).
        await this.record(binding, event, 'busy', 'That flow was already running, so this event joined the run in progress.', { runId: started.runId });
        return { ok: true, status: 'busy', runId: started.runId };
      }
      await this.record(binding, event, 'ran', 'It started the flow.', { runId: started?.runId });
      return { ok: true, status: 'ran', runId: started?.runId };
    } catch (e: any) {
      // A flow that will not start is the flow's problem, not the rule's: the binding stays on, and
      // the failure is in the history where the owner can see it.
      const why = String(e?.message || e).slice(0, 300);
      await this.record(binding, event, 'failed', `The flow could not start: ${why}`);
      this.log.warn(`trigger ${binding.triggerType} could not start flow ${binding.flowId}: ${why}`);
      return { ok: true, status: 'failed', message: why };
    }
  }

  /** A login expired, or the provider switched a trigger off at its end. Written down, and said. */
  private async handleNotice(event: ReturnType<TriggersService['readEvent']>): Promise<{ ok: boolean; status: string }> {
    const binding = await this.bindingFor(event);
    const reason = event.kind === 'disabled'
      ? `${this.serviceName(event.service)} stopped sending this event — the sign-in may have expired. Reconnect it in Tools, then switch this rule back on.`
      : `The ${this.serviceName(event.service)} sign-in has expired. Reconnect it in Tools.`;
    // `alreadyGone` — the provider has already stopped this one at its end, so there is nothing left
    // to delete and asking it to would only produce a 404.
    const paused = !!binding && event.kind === 'disabled';
    if (paused) await this.pauseBinding(binding, reason, { alreadyGone: true });
    await this.record(binding, event, 'ignored', reason);
    // Only when pausing has not already said it — two identical messages for one thing is noise, and
    // noise is how a message that matters gets skimmed past.
    if (!paused) await this.telegram?.notifyTriggerPaused?.({ what: binding ? this.title(binding) : this.serviceName(event.service), reason })?.catch?.(() => undefined);
    return { ok: true, status: 'notice' };
  }

  // ---- the pieces --------------------------------------------------------------------------

  /** Stop a rule and say why, in the row and to the owner. The subscription goes too. */
  private async pauseBinding(binding: any, reason: string, opts: { alreadyGone?: boolean } = {}): Promise<void> {
    if (!opts.alreadyGone) await this.stopListening(binding.triggerInstanceId);
    await this.prisma.triggerBinding
      .update({ where: { id: binding.id }, data: { enabled: false, triggerInstanceId: null, pausedReason: reason.slice(0, 400) } })
      .catch((e: any) => this.log.warn(`could not pause ${binding.id}: ${e?.message || e}`));
    this.log.warn(`trigger binding ${binding.id} paused itself: ${reason}`);
    await this.telegram?.notifyTriggerPaused?.({ what: this.title(binding), reason })?.catch?.(() => undefined);
  }

  private async startListening(triggerType: string, config: Record<string, any>, accountId?: string) {
    const p: ServiceProvider = this.provider as any;
    if (!p?.createTriggerInstance) return { ok: false, message: 'This server cannot subscribe to service events.' };
    return p.createTriggerInstance(triggerType, config || {}, accountId ? { connectionId: accountId } : {});
  }

  /** Take the subscription away. Nothing to take away is a success — the wanted state is "gone". */
  private async stopListening(instanceId?: string | null): Promise<{ ok: boolean; message?: string }> {
    if (!instanceId) return { ok: true };
    const p: ServiceProvider = this.provider as any;
    if (!p?.deleteTriggerInstance) return { ok: true };
    const r = await p.deleteTriggerInstance(instanceId).catch((e: any) => ({ ok: false, message: String(e?.message || e) }));
    // The reason is the provider's own; the consequence is ours, and it has to be said. Carrying on
    // regardless would leave a subscription nobody owns, still sending events, still being billed.
    if (!r?.ok) return { ok: false, message: `${r?.message || 'We could not stop the service sending this event.'} So nothing was changed — the rule is still there.` };
    return { ok: true };
  }

  /**
   * The recent calls the echo guard is shown: the same service, inside the window, **whatever kind of
   * run made them**.
   *
   * Never narrowed by `runKind` on purpose. Chat writes to this same log now (BEA-1349), and a
   * message the owner sent from Chat comes back through the trigger exactly like one an agent sent.
   */
  private async recentCalls(binding: any): Promise<ToolCallRow[]> {
    const since = new Date(Date.now() - this.echoWindowMinutes(binding) * 60_000);
    const rows = (await this.prisma.toolCall
      ?.findMany?.({ where: { service: binding.service, ok: true, createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: ECHO_CALL_LIMIT })
      .catch(() => [])) || [];
    return rows as ToolCallRow[];
  }

  /** A polled event can be a whole interval late, so the window is built from its own interval. */
  private echoWindowMinutes(binding: any): number {
    const interval = Number(this.parse(binding?.config)?.interval);
    const wanted = Number.isFinite(interval) && interval > 0 ? interval * 2 + ECHO_MIN_MINUTES : ECHO_MIN_MINUTES;
    return Math.min(ECHO_MAX_MINUTES, Math.max(ECHO_MIN_MINUTES, wanted));
  }

  /** How many runs this rule has started in the last hour — the rate cap's only measure. */
  private async runsInLastHour(bindingId: string): Promise<number> {
    const since = new Date(Date.now() - 60 * 60_000);
    const n = await this.prisma.triggerEvent
      ?.count?.({ where: { bindingId, status: { in: ['ran', 'busy'] }, createdAt: { gte: since } } })
      .catch(() => 0);
    return Number(n) || 0;
  }

  /** Which rule is this event for? The subscription id first, because it is exact. */
  private async bindingFor(event: { instanceId?: string; triggerType?: string; service?: string }): Promise<any | null> {
    if (event?.instanceId) {
      const byInstance = await this.prisma.triggerBinding?.findFirst?.({ where: { triggerInstanceId: event.instanceId } }).catch(() => null);
      if (byInstance) return byInstance;
    }
    if (event?.triggerType) {
      const byType = await this.prisma.triggerBinding
        ?.findFirst?.({ where: { triggerType: event.triggerType, ...(event.service ? { service: event.service } : {}) }, orderBy: { createdAt: 'desc' } })
        .catch(() => null);
      if (byType) return byType;
    }
    return null;
  }

  /**
   * What arrived, in the few fields we act on.
   *
   * Written to survive the provider's shapes rather than to match one: the same event has been sent
   * as `data.trigger_slug` and as `metadata.triggerName` across versions, so every field is looked
   * for in each of its known homes and nothing here throws on a shape it has not seen.
   */
  private readEvent(body: any) {
    const b = body && typeof body === 'object' ? body : {};
    const d = (b.data && typeof b.data === 'object' ? b.data : b) as any;
    const meta = (d.metadata || b.metadata || {}) as any;
    const type = String(b.type || b.event_type || b.eventType || '').toLowerCase();
    // Anything that is not plainly one of the two notices is treated as a real event — a provider
    // that renames its message type must not have every event of ours silently reclassified.
    const kind = type.includes('connected_account') ? 'expired' : type.includes('disabled') ? 'disabled' : 'message';
    const instanceId = this.first(d.trigger_id, d.triggerId, b.trigger_id, meta.id, meta.triggerId, d.id);
    const vendorTrigger = this.first(d.trigger_slug, d.triggerSlug, d.trigger_name, d.triggerName, b.trigger_slug, b.triggerName, meta.triggerName);
    const service = String(
      this.first(d.toolkit_slug, d.toolkitSlug, d.app_name, d.appName, b.appName, b.toolkit_slug, meta.connectedAccount?.appName, meta.appName) || '',
    ).toLowerCase();
    const payload = d.payload !== undefined ? d.payload : b.payload !== undefined ? b.payload : d;
    const triggerType = vendorTrigger && service ? `evt:${service}.${String(vendorTrigger).toLowerCase().replace(new RegExp(`^${service}_`), '')}` : undefined;
    return {
      kind,
      instanceId: instanceId ? String(instanceId) : undefined,
      service: service || undefined,
      triggerType: triggerType && isServiceEventId(triggerType) ? triggerType : undefined,
      payload,
      raw: b,
    };
  }

  /** What the woken flow is handed: what happened, in a sentence, then the event itself. */
  private runInput(event: { service?: string; triggerType?: string; payload?: any }, binding: any): string {
    const name = this.eventName(binding?.triggerType || event.triggerType);
    const head = `${this.serviceName(binding?.service || event.service)} says: ${name}. This just happened, and it is why this run started.`;
    return `${head}\n\nWhat happened:\n${this.pretty(event.payload).slice(0, RUN_INPUT_CHARS)}`;
  }

  /** Write the event down, whatever we did with it, and trim the rule's history as it goes. */
  private async record(binding: any | null, event: any, status: string, detail?: string, extra: { runId?: string; echoOfId?: string } = {}): Promise<void> {
    try {
      await this.prisma.triggerEvent?.create?.({
        data: {
          bindingId: binding?.id || null,
          service: String(binding?.service || event?.service || 'unknown'),
          triggerType: binding?.triggerType || event?.triggerType || null,
          status,
          detail: detail ? String(detail).slice(0, 400) : null,
          runId: extra.runId || null,
          summary: this.summarise(event?.payload),
          echoOfId: extra.echoOfId || null,
          payload: this.pretty(event?.payload).slice(0, KEPT_PAYLOAD_CHARS),
        },
      });
      if (binding?.id) await this.trim(binding.id);
    } catch (e: any) {
      this.log.warn(`could not write the trigger event row: ${e?.message || e}`);
    }
  }

  /** Keep the last N events of a rule. A busy trigger must not grow the database for ever. */
  private async trim(bindingId: string): Promise<void> {
    const n = Number(await this.prisma.triggerEvent?.count?.({ where: { bindingId } }).catch(() => 0)) || 0;
    if (n <= HISTORY_PER_BINDING) return;
    const old = (await this.prisma.triggerEvent
      ?.findMany?.({ where: { bindingId }, orderBy: { createdAt: 'desc' }, skip: HISTORY_PER_BINDING, select: { id: true } })
      .catch(() => [])) || [];
    if (old.length) await this.prisma.triggerEvent?.deleteMany?.({ where: { id: { in: old.map((r: any) => r.id) } } }).catch(() => undefined);
  }

  // ---- small helpers -----------------------------------------------------------------------

  private shape(r: any) {
    return {
      id: r.id,
      service: r.service,
      triggerType: r.triggerType,
      eventName: this.eventName(r.triggerType),
      listening: !!r.triggerInstanceId,
      flowId: r.flowId,
      config: this.parse(r.config) || {},
      accountId: r.accountId,
      label: r.label,
      enabled: !!r.enabled,
      rateCap: this.cap(r.rateCap),
      lastFiredAt: r.lastFiredAt,
      pausedReason: r.pausedReason,
      createdAt: r.createdAt,
    };
  }

  /** `evt:github.pull_request_event` → "Pull request event". */
  private eventName(triggerType?: string): string {
    const body = parseServiceEventId(String(triggerType || ''))?.trigger || String(triggerType || '');
    const text = body.replace(/_/g, ' ').replace(/\s*trigger$/i, '').trim();
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'an event';
  }

  private serviceName(service?: string): string {
    const s = String(service || '').trim();
    if (!s) return 'A service';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  private title(binding: any): string {
    return String(binding?.label || '').trim() || `${this.serviceName(binding?.service)} · ${this.eventName(binding?.triggerType)}`;
  }

  /** A cap of nought would mean "never run", which nobody wants by accident. One is the floor. */
  private cap(n: any): number {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v <= 0) return DEFAULT_RATE_CAP;
    return Math.min(1000, v);
  }

  private first(...values: any[]): any {
    for (const v of values) if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    return undefined;
  }

  private parse(text: any): any {
    if (!text) return null;
    if (typeof text === 'object') return text;
    try { return JSON.parse(String(text)); } catch { return null; }
  }

  private pretty(payload: any): string {
    if (payload === undefined || payload === null) return '(nothing)';
    if (typeof payload === 'string') return payload;
    try { return JSON.stringify(payload, null, 2); } catch { return String(payload); }
  }

  /** One readable line about the event, so the history is skimmable without opening anything. */
  private summarise(payload: any): string {
    if (payload === undefined || payload === null) return '';
    if (typeof payload === 'string') return payload.replace(/\s+/g, ' ').slice(0, 160);
    const seen = new Set<any>();
    const find = (v: any, depth: number): string => {
      if (!v || typeof v !== 'object' || depth > 3 || seen.has(v)) return '';
      seen.add(v);
      for (const k of SUMMARY_KEYS) {
        const val = (v as any)[k];
        if (typeof val === 'string' && val.trim()) return val.replace(/\s+/g, ' ').trim();
      }
      for (const val of Object.values(v)) {
        const deeper = find(val, depth + 1);
        if (deeper) return deeper;
      }
      return '';
    };
    return find(payload, 0).slice(0, 160);
  }

  private async getSetting(key: string): Promise<string> {
    const r = await this.prisma.setting?.findUnique?.({ where: { key } }).catch(() => null);
    return String((r as any)?.value || '');
  }

  private async setSetting(key: string, value: string): Promise<void> {
    await this.prisma.setting?.upsert?.({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined);
  }
}
