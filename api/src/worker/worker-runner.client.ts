import { Injectable, Logger } from '@nestjs/common';

/** The host service that owns the worker folders (BEA-1389). Overridden in `deploy.sh`. */
const RUNNER = process.env.WORKER_RUNNER_URL || 'http://172.18.0.1:8769';
/** Off by default, like every other host runner on this VPS — set on both sides to lock the door. */
const RUNNER_TOKEN = process.env.WORKER_RUNNER_TOKEN || '';

/** A Codex build turn is minutes, not seconds: the runner caps it, this is the client's own patience. */
const BUILD_TIMEOUT_MS = Number(process.env.WORKER_BUILD_TIMEOUT_MS || 20 * 60_000);
const SHORT_TIMEOUT_MS = 20_000;

export type RunnerBuildResult = {
  ok: boolean;
  version?: number;
  dir?: string;
  wrote?: boolean;
  tests?: { passed: number; failed: number; at?: string } | null;
  sessionId?: string | null;
  timedOut?: boolean;
  log?: string;
  error?: string;
};

export type RunnerPromoteResult = { ok: boolean; version?: number; previous?: string | null; error?: string };

/** What one spawn came back as. `waiting` = it parked on a question and exited (BEA-1392 §H). */
export type RunnerRunResult = { status: 'done' | 'failed' | 'waiting'; rows?: number | null; error?: string | null; waitpointId?: string | null; timedOut?: boolean; kitRefused?: boolean };

/** A worker run's own patience. The runner caps it too; this is the client's side of the same wait. */
const RUN_TIMEOUT_MS = Number(process.env.WORKER_RUN_TIMEOUT_MS || 30 * 60_000);

/**
 * The app's one door to the worker runner (BEA-1390 — `specs/AGENT-WORKERS.md` §F).
 *
 * The app decides everything: which plan is compiled, which files go into the version folder, and
 * whether a version may go live. The runner is the only side that can touch the disk and start a
 * process, so it does those two things and nothing else — it never opens the database, and it never
 * promotes a worker by itself.
 *
 * Every method answers a plain object, never throws: a runner that is not installed yet (the
 * systemd unit needs root) must read as "the build could not run", not as a crash in the owner's UI.
 */
@Injectable()
export class WorkerRunnerClient {
  private readonly log = new Logger('WorkerRunner');

  get url(): string {
    return RUNNER;
  }

  /** Readiness, in the codex runner's own shape, so the engine pill can show it unchanged. */
  async status(): Promise<any> {
    try {
      const r = await fetch(`${RUNNER}/status`, { signal: AbortSignal.timeout(SHORT_TIMEOUT_MS) });
      if (!r.ok) return { connected: false, ready: false, reason: `the worker runner answered ${r.status}` };
      const s: any = await r.json();
      return { connected: true, ...s };
    } catch (e: any) {
      return { connected: false, ready: false, reason: reasonOf(e) };
    }
  }

  /**
   * One fresh Codex session in a NEW version folder: the files first, then `codex exec -s
   * workspace-write -C vN`, then that version's own tests. It does not promote — that is this app's
   * decision, and it is made on the tests.
   */
  async build(input: { jobId: string; brief: string; files: Record<string, string>; timeoutMs?: number }): Promise<RunnerBuildResult> {
    try {
      const r = await fetch(`${RUNNER}/build`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jobId: input.jobId, brief: input.brief, files: input.files, timeoutMs: input.timeoutMs }),
        signal: AbortSignal.timeout(input.timeoutMs ? input.timeoutMs + 60_000 : BUILD_TIMEOUT_MS),
      });
      const json: any = await r.json().catch(() => null);
      if (!r.ok) return { ok: false, error: json?.error || `the worker runner answered ${r.status}`, ...(json || {}) };
      return { ok: !!json?.ok, ...(json || {}) };
    } catch (e: any) {
      this.log.warn(`build for ${input.jobId} could not run: ${e?.message || e}`);
      return { ok: false, error: `The build could not run — ${reasonOf(e)}.` };
    }
  }

  /**
   * Spawn one worker and wait for its last word (BEA-1392). The steps the owner reads do not come
   * back this way — the worker writes them itself through `/api/worker/step` as they happen — so
   * the ndjson body is only the runner's own log, and the line that matters is the final
   * `{type:'result'}`. `waiting` means the worker parked on a question and exited; the run is
   * already `awaiting_input` by then, and nothing here has to do anything about it.
   */
  async run(input: { jobId: string; runId: string; token: string; seed?: { now: number; random: number }; kit?: string; timeoutMs?: number }): Promise<RunnerRunResult> {
    try {
      const r = await fetch(`${RUNNER}/run`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(input.timeoutMs ? input.timeoutMs + 60_000 : RUN_TIMEOUT_MS),
      });
      const text = await r.text().catch(() => '');
      if (!r.ok) {
        let why = `the worker runner answered ${r.status}`;
        try { why = JSON.parse(text)?.error || why; } catch { /* not JSON — the status stands */ }
        return { status: 'failed', error: why };
      }
      const result = lastResult(text);
      if (!result) return { status: 'failed', error: 'The worker runner said nothing about how the run ended.' };
      return result;
    } catch (e: any) {
      this.log.warn(`run ${input.runId} could not be spawned: ${e?.message || e}`);
      return { status: 'failed', error: `The worker could not be started — ${reasonOf(e)}.` };
    }
  }

  /** The `current` symlink move: promotion, and the same move back for a rollback. */
  async promote(input: { jobId: string; version: number; meta?: any }): Promise<RunnerPromoteResult> {
    try {
      const r = await fetch(`${RUNNER}/promote`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      });
      const json: any = await r.json().catch(() => null);
      if (!r.ok || !json?.ok) return { ok: false, error: json?.error || `the worker runner answered ${r.status}` };
      return { ok: true, version: json.version, previous: json.previous ?? null };
    } catch (e: any) {
      return { ok: false, error: `The worker could not be put live — ${reasonOf(e)}.` };
    }
  }

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', ...(RUNNER_TOKEN ? { 'x-runner-token': RUNNER_TOKEN } : {}) };
  }
}

/** The runner's final line out of an ndjson body. Anything before it is log, and none of it is trusted. */
function lastResult(body: string): RunnerRunResult | null {
  const lines = String(body || '').split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let ev: any = null;
    try { ev = JSON.parse(lines[i]); } catch { ev = null; }
    if (ev?.type !== 'result') continue;
    const status = ev.status === 'done' || ev.status === 'waiting' ? ev.status : 'failed';
    return { status, rows: typeof ev.rows === 'number' ? ev.rows : null, error: ev.error ? String(ev.error) : null, waitpointId: ev.waitpointId || null, timedOut: !!ev.timedOut, kitRefused: !!ev.kitRefused };
  }
  return null;
}

function reasonOf(e: any): string {
  if (e?.name === 'TimeoutError') return 'the worker runner did not answer in time';
  return `the worker runner could not be reached (${String(e?.message || e).slice(0, 120)})`;
}
