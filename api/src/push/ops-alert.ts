import { plumbingClassOf } from '../agent/failure-words';

/**
 * Plumbing failures phone home (BEA-1581).
 *
 * Every bug this past week was found because the owner IS the user. A paying myemo customer will
 * not report *"no readable meta.json"* — he will churn. So WHEN a failure lands in one of
 * BEA-1580's plumbing classes (OUR infrastructure, never his ask), ONE ops alert goes out to us:
 * instance id, failure class, agent/run id, and the honest internal sentence — before he writes in.
 *
 * The shape is the `setOwnerAlertTelegram` pattern (contacts/owner-alert.ts): this file is plain
 * functions, and `TelegramService` registers itself here at boot — so the worker/push side never
 * imports TelegramModule and the module direction (Telegram → Daily → Mentor → Push, never back)
 * holds. The myemo control plane can swap the transport later without touching a single call site.
 *
 * WHAT alerts is decided by `plumbingClassOf` — BEA-1580's ONE classifier — and by nothing else.
 * There is deliberately no second list here: add a class to `PLUMBING_CLASSES` and the alert learns
 * it for free; a customer-actionable failure (bad goal, disconnected tool, vendor down — his six
 * moves or a wait) classifies null and never reaches us.
 */

/** The transport a boot-time service registers. Today: `TelegramService.sendOps`. */
export type OpsAlertTransport = {
  sendOps: (text: string) => Promise<{ sent: boolean; why?: string } | void>;
};

let transport: OpsAlertTransport | null = null;
export function setOpsAlertTransport(t: OpsAlertTransport | null): void {
  transport = t;
}

/** Which instance is phoning home — the myemo control plane runs one per customer. */
export function opsInstanceId(): string {
  return String(process.env.INSTANCE_ID || '').trim() || 'mybrain';
}

/**
 * Dedupe per (class, agentId) per LOCAL day — IN MEMORY on purpose. The sweeper and the repair
 * queue re-detect a stuck plumbing state every tick, and one alert a day per (class, agent) is the
 * signal; a restart clearing this map and re-alerting once is accepted (the brief says so) — a
 * table for it would be more machinery than the failure mode deserves.
 */
const sentOn = new Map<string, string>();
let sentDay = '';

/** yyyy-mm-dd in the SERVER's local day — the same day the sweeper's ticks live in. */
export function opsLocalDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Tests only: a fresh day, nothing remembered. */
export function resetOpsAlerts(): void {
  sentOn.clear();
  sentDay = '';
}

export type OpsAlertInput = {
  /** The plumbing class id from `plumbingClassOf` — the dedupe key's first half. */
  klass: string;
  agentId?: string | null;
  runId?: string | null;
  /** The honest internal sentence, exactly as it was stored — never the calm customer shape. */
  message: string;
  /** Tests pin the clock; production never passes it. */
  now?: Date;
};

/**
 * The ONE seam (BEA-1581). Sends at most one alert per (class, agentId) per local day; answers
 * whether a transport call was made. Never throws — the alert leg must never fail the path it
 * observes, so every road out of here is caught.
 */
export async function opsAlert(a: OpsAlertInput): Promise<boolean> {
  try {
    if (!transport) return false; // nothing registered (specs, or before boot) — not marked as sent
    const day = opsLocalDay(a.now);
    if (day !== sentDay) {
      sentOn.clear(); // yesterday's keys never pile up
      sentDay = day;
    }
    const key = `${a.klass}|${a.agentId || ''}`;
    if (sentOn.get(key) === day) return false;
    // Marked BEFORE the send: "exactly one transport call that day" — a transport that throws or
    // answers "not sent" does not earn a retry storm from the next tick.
    sentOn.set(key, day);
    const ids = [a.agentId ? `agent ${a.agentId}` : '', a.runId ? `run ${a.runId}` : ''].filter(Boolean).join(' · ');
    const text = `⚠️ [${opsInstanceId()}] plumbing: ${a.klass}${ids ? ` · ${ids}` : ''}\n${String(a.message || '').slice(0, 800)}`;
    await Promise.resolve(transport.sendOps(text)).catch(() => undefined);
    return true;
  } catch {
    return false; // the observed path completes no matter what
  }
}

/**
 * What every detection point calls: classify with BEA-1580's classifier, alert only on a plumbing
 * class. Fire-and-forget — the caller's own path never waits on Telegram and never sees a throw.
 */
export function opsAlertIfPlumbing(error: unknown, ids: { agentId?: string | null; runId?: string | null } = {}): void {
  try {
    const klass = plumbingClassOf(error);
    if (!klass) return; // customer-actionable — his six moves, not our pager
    void opsAlert({ klass, agentId: ids.agentId, runId: ids.runId, message: String(error ?? '') }).catch(() => undefined);
  } catch {
    /* never into the observed path */
  }
}
