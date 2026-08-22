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

function reasonOf(e: any): string {
  if (e?.name === 'TimeoutError') return 'the worker runner did not answer in time';
  return `the worker runner could not be reached (${String(e?.message || e).slice(0, 120)})`;
}
