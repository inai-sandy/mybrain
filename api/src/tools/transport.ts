import { Logger } from '@nestjs/common';

/**
 * Transport-level failures, named and retried once (BEA-1364).
 *
 * The first Social call after a deploy was failing in ~500 ms with a bare "fetch failed" — undici's
 * TypeError, whose real reason (`ECONNRESET`, `EAI_AGAIN`, a TLS error…) sits on `e.cause` and was
 * being dropped on the floor. Two rules live here, shared by every provider that speaks HTTP:
 *
 *   1. **The cause is named.** `describeTransportError()` turns that TypeError into
 *      `fetch failed (ECONNRESET: socket hang up)` — code + message, no stack, never a key.
 *   2. **A pure transport failure is retried once**, after a short pause. "Pure" means the
 *      `fetch()` promise itself rejected — the request never got an answer. A timeout
 *      (`TimeoutError` / `AbortError`), any HTTP status and any vendor "no" in the body all mean the
 *      call reached the vendor (and may have been charged), so they are NEVER retried here — the
 *      caller reads those off the Response as it always did.
 */

const RETRY_AFTER_MS = 400;

const log = new Logger('Transport');

/** True when `e` is a rejected `fetch()` that never got an answer — not a timeout / abort. */
export function isTransportError(e: any): boolean {
  if (!e) return false;
  const name = String(e.name || '');
  if (name === 'TimeoutError' || name === 'AbortError') return false;
  if (e.status !== undefined) return false; // an HTTP answer someone wrapped in an Error
  return true;
}

/** `ECONNRESET: socket hang up` from undici's `cause`, or '' when there is none. Never a stack. */
export function transportCause(e: any): string {
  const c = e?.cause;
  if (!c) return '';
  const name = String(c.name || '');
  const code = String(c.code || (/^(Error|TypeError)$/.test(name) ? '' : name)).trim();
  const msg = String(c.message || '').trim();
  const text = code && msg && msg !== code ? `${code}: ${msg}` : code || msg;
  return text.slice(0, 160);
}

/** `fetch failed (ECONNRESET: socket hang up)` — the message the owner reads and the log line carries. */
export function describeTransportError(e: any): string {
  const message = String(e?.message || 'fetch failed').split('\n')[0].slice(0, 120);
  const cause = transportCause(e);
  return cause ? `${message} (${cause})` : message;
}

/**
 * `fetch()`, retried ONCE when the promise itself rejects with a transport error. Anything else —
 * a Response of any status, a timeout, an abort — comes back / rethrows untouched on the first try.
 * Each transport failure is logged once at warn level with the host, so the VPS-side cause is on
 * record even when the retry saves the call.
 */
export async function fetchWithRetry(url: string, init: RequestInit, opts: { timeoutMs?: number; retryAfterMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<Response> {
  const host = hostOf(url);
  // A fresh timeout per attempt — an `AbortSignal.timeout()` keeps its clock from creation, so
  // reusing one would hand the retry whatever was left, not the full budget.
  const attempt = () => fetch(url, opts.timeoutMs && opts.timeoutMs > 0 ? { ...init, signal: AbortSignal.timeout(opts.timeoutMs) } : init);
  try {
    return await attempt();
  } catch (e: any) {
    if (!isTransportError(e)) throw e;
    log.warn(`${host}: ${describeTransportError(e)} — retrying once`);
    await (opts.sleep || sleep)(opts.retryAfterMs ?? RETRY_AFTER_MS);
    try {
      return await attempt();
    } catch (e2: any) {
      if (isTransportError(e2)) log.warn(`${host}: ${describeTransportError(e2)} — giving up after the retry`);
      throw e2;
    }
  }
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'unknown host'; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
