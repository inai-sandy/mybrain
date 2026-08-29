import { HELPER_RETRIES, LlmService } from './llm.service';
import { TokenBudgetError } from './token-budget.service';

/**
 * A MODEL HICCUP IS RETRIED LIKE A VENDOR HICCUP (BEA-1582).
 *
 * 2026-08-29, live: the Daily Email Agent's run died on "the worker-think model returned nothing" —
 * one transient blank at OpenRouter, which answered the same call fine minutes later. One provider
 * blink failed the run AND queued a self-repair against a worker that was never broken.
 *
 * BEA-1496 already decided this class for vendors — a blip is not a failed run, handled at the one
 * call site. `completeHelper` is the model's one call site, so the retry lives there, and this file
 * locks its rules:
 *
 *  - a transient blank is retried on the SAME model, and the answer is kept (no-cheaper-models);
 *  - all-blank still returns null (BEA-1248's verdict stands — never the general model);
 *  - interactive helpers (a person mid-chat) fail fast, decided in ONE place, never per caller;
 *  - engine (flat-rate) turns are never retried here — that road has its own chain and budget;
 *  - a budget stop throws straight through — it is a real answer, not a blip;
 *  - the backoff is zero under Jest, so no spec ever sleeps.
 */

/** A service whose model calls follow a script: each entry is one call's reply (or a throw). */
function svc(script: Array<string | null | Error>, cfg: any = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5' }) {
  const s: any = new LlmService({} as any, {} as any);
  const calls: any[][] = [];
  const warned: string[] = [];
  s.log = { warn: (m: string) => warned.push(m), error: () => {}, log: () => {} };
  s.helperModel = async () => cfg;
  s.completeWithModel = async (...args: any[]) => {
    calls.push(args);
    const next = script.length ? script.shift() : null;
    if (next instanceof Error) throw next;
    return { text: next ?? null };
  };
  s.complete = async () => 'FROM THE GENERAL MODEL';
  return { s: s as LlmService, calls, warned };
}

describe('a model hiccup is retried like a vendor hiccup (BEA-1582)', () => {
  it('a transient blank is retried on the SAME model, the answer is kept, and a ↻ line is said', async () => {
    const { s, calls, warned } = svc([null, 'the answer']);
    expect(await s.completeHelper('worker-think', 'p')).toBe('the answer');
    expect(calls).toHaveLength(2);
    // The SAME config both times — never a fallback model (the owner's rule).
    expect(calls[1][0]).toEqual(calls[0][0]);
    // Said out loud, the BEA-1496 pattern: a silent retry hides a degrading provider.
    expect(warned.some((m) => m.includes('↻') && m.includes('worker-think'))).toBe(true);
  });

  it('a whitespace-only reply is a blank too', async () => {
    const { s, calls } = svc(['   \n', 'real words']);
    expect(await s.completeHelper('worker-think', 'p')).toBe('real words');
    expect(calls).toHaveLength(2);
  });

  it('all-blank returns null after its tries — never the general model (BEA-1248 stands)', async () => {
    const { s, calls } = svc([null, null, null, null]);
    expect(await s.completeHelper('worker-think', 'p')).toBeNull();
    expect(calls).toHaveLength(1 + HELPER_RETRIES);
  });

  it('an interactive helper fails fast — one call, no retry, no ↻ line', async () => {
    for (const key of ['chat-edit', 'agent-builder']) {
      const { s, calls, warned } = svc([null, 'it would have answered on a retry']);
      expect(await s.completeHelper(key, 'p')).toBeNull();
      expect(calls).toHaveLength(1);
      expect(warned).toHaveLength(0);
    }
  });

  it('the interactive set is decided in ONE place — the chat builders and their kin are all in it', () => {
    for (const key of ['chat-edit', 'agent-builder', 'agent-goal', 'draft', 'draft-check', 'ui-spec', 'sync-words', 'suggest-evals']) {
      expect(LlmService.INTERACTIVE_HELPERS.has(key)).toBe(true);
    }
    // …and the run-side helpers the incident was about are NOT.
    for (const key of ['worker-think', 'social-shape', 'social-alert', 'service-args', 'agent-grade']) {
      expect(LlmService.INTERACTIVE_HELPERS.has(key)).toBe(false);
    }
  });

  it('an engine (flat-rate) turn is never retried here — that road has its own chain and budget', async () => {
    const { s, calls } = svc([null, 'a second engine turn that must not happen'], { provider: 'codex', model: 'codex' });
    expect(await s.completeHelper('worker-think', 'p')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('a budget stop throws straight through with no retry — it is a real answer, not a blip', async () => {
    const stop = new TokenBudgetError("today's AI budget is used up");
    const { s, calls } = svc([stop, 'never reached']);
    await expect(s.completeHelper('worker-think', 'p')).rejects.toBe(stop);
    expect(calls).toHaveLength(1);
  });

  it('the backoff is a zeroable constant, already zero under Jest — the suite never sleeps', () => {
    expect(process.env.JEST_WORKER_ID).toBeTruthy();
    expect(LlmService.HELPER_RETRY_BACKOFF_MS.every((n) => n === 0)).toBe(true);
  });

  it('a helper with no model of its own still falls to the app default, untouched', async () => {
    const { s, calls } = svc([], null);
    expect(await s.completeHelper('something-unregistered', 'p')).toBe('FROM THE GENERAL MODEL');
    expect(calls).toHaveLength(0);
  });
});
