import { Injectable, Logger } from '@nestjs/common';
import { ParityResult } from './repair';

/** The host service that owns the worker folders (BEA-1389). Overridden in `deploy.sh`. */
const RUNNER = process.env.WORKER_RUNNER_URL || 'http://172.18.0.1:8769';
/**
 * The runner's shared secret. **Required on both sides since BEA-1401**: the runner refuses every
 * route but `/status` without it, so an app that does not send it simply has no worker road — every
 * run falls back to the plan runner and says so. Set in `.claude/checks/secrets.env` → `deploy.sh`,
 * and the same value in `/home/sandy/worker-runner/runner.env` on the host. Never in code or git.
 */
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

/** What one version produced when it was run against the saved answers (BEA-1393). */
export type RunnerParityResult = { ok: boolean; version?: number; result?: ParityResult; log?: string | null; error?: string };

/** A parity measurement is a few seconds of local work; this is only the patience for a stuck one. */
const PARITY_TIMEOUT_MS = Number(process.env.WORKER_PARITY_TIMEOUT_MS || 3 * 60_000);

/**
 * What one spawn came back as. `waiting` = it parked on a question and exited (BEA-1392 §H).
 *
 * `notStarted` is the dispatch switch's own field (BEA-1394): the runner refused BEFORE spawning
 * anything — no worker installed, a kit it cannot run, the job busy on the host, or the runner not
 * reachable at all. Nothing ran, so nothing was fetched, written or sent, and the run may quietly go
 * the old way instead of failing. A worker that STARTED and then failed never carries it.
 */
export type RunnerRunResult = { status: 'done' | 'failed' | 'waiting'; rows?: number | null; error?: string | null; waitpointId?: string | null; timedOut?: boolean; kitRefused?: boolean; notStarted?: boolean };

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

  constructor() {
    // Said once, loudly, at boot — the mirror of the runner's own line. A missing secret is not a
    // crash, it is a road that is closed, and the owner should be able to see why in the log.
    if (!RUNNER_TOKEN) {
      this.log.warn('WORKER_RUNNER_TOKEN is not set here, so the worker runner will refuse every call — jobs on the worker road will run the old way and say so (BEA-1401).');
    }
  }

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
  async build(input: { jobId: string; brief: string; files: Record<string, string>; copyFrom?: number | null; timeoutMs?: number; buildKey?: string }): Promise<RunnerBuildResult> {
    try {
      const r = await fetch(`${RUNNER}/build`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jobId: input.jobId, brief: input.brief, files: input.files, copyFrom: input.copyFrom ?? null, timeoutMs: input.timeoutMs, buildKey: input.buildKey }),
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
        // A non-200 means the request never became a spawn: bad body, or a runner that is not
        // willing. Nothing ran, so this is a road that was unavailable, not a run that failed.
        return { status: 'failed', error: why, notStarted: true };
      }
      const result = lastResult(text);
      if (!result) return { status: 'failed', error: 'The worker runner said nothing about how the run ended.' };
      return result;
    } catch (e: any) {
      this.log.warn(`run ${input.runId} could not be spawned: ${e?.message || e}`);
      // The runner is not installed yet (its systemd unit needs root), is down, or timed out on its
      // way to answering. Either way nothing of ours ran.
      return { status: 'failed', error: `The worker could not be started — ${reasonOf(e)}.`, notStarted: true };
    }
  }

  /**
   * Measure ONE version against the saved answers (BEA-1393, the promotion guard). The harness is
   * the app's (`parity-harness.ts`), the fixtures are the app's, and the version folder is copied
   * rather than touched — so both versions are measured with the same ruler on the same answers,
   * and neither measurement can reach a vendor.
   */
  async parity(input: { jobId: string; version: number; harness: string; files?: Record<string, string>; timeoutMs?: number }): Promise<RunnerParityResult> {
    try {
      const r = await fetch(`${RUNNER}/parity`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jobId: input.jobId, version: input.version, harness: input.harness, files: input.files || {}, timeoutMs: input.timeoutMs }),
        signal: AbortSignal.timeout(input.timeoutMs ? input.timeoutMs + 30_000 : PARITY_TIMEOUT_MS),
      });
      const json: any = await r.json().catch(() => null);
      if (!r.ok || !json?.ok) return { ok: false, error: json?.error || `the worker runner answered ${r.status}` };
      return { ok: true, version: json.version, result: json.result, log: json.log || null };
    } catch (e: any) {
      return { ok: false, error: `The repair could not be measured — ${reasonOf(e)}.` };
    }
  }

  /**
   * Delete a job's worker folders — every version, the `current` symlink, the briefs and the saved
   * answers its tests stood on (BEA-1394 §I, "deleting an agent deletes its worker"). Idempotent: a
   * job with no folder answers ok, because that is already the state the caller wants.
   */
  /**
   * Stop a run's worker on the host, now (BEA-1541).
   *
   * Never throws and never blocks a cancel: a runner that is down must not make a run impossible to
   * cancel. `stopped:false` means there was nothing of that run running there — which is the normal
   * answer when the work had already finished, and is not a failure.
   */
  /**
   * What a build is saying right now (BEA-1545).
   *
   * Read-only and never throws: this is watched on a timer while a build runs, and a hiccup must show
   * as "nothing new yet", never as an error in front of him.
   */
  async buildLog(jobId: string): Promise<{ running: boolean; log: string; ranForMs?: number }> {
    try {
      const r = await fetch(`${RUNNER}/build-log?jobId=${encodeURIComponent(jobId)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      });
      const json: any = await r.json().catch(() => null);
      if (!r.ok || !json?.ok) return { running: false, log: '' };
      return { running: !!json.running, log: String(json.log || ''), ranForMs: Number(json.ranForMs) || 0 };
    } catch {
      return { running: false, log: '' };
    }
  }

  async stop(runId: string): Promise<{ ok: boolean; stopped?: boolean; error?: string }> {
    try {
      const r = await fetch(`${RUNNER}/stop`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ runId }),
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      });
      const json: any = await r.json().catch(() => null);
      if (!r.ok || !json?.ok) return { ok: false, error: json?.error || `the worker runner answered ${r.status}` };
      return { ok: true, stopped: !!json.stopped };
    } catch (e: any) {
      return { ok: false, error: `The worker could not be stopped on the host — ${reasonOf(e)}.` };
    }
  }

  async remove(jobId: string): Promise<{ ok: boolean; removed?: boolean; error?: string }> {
    try {
      const r = await fetch(`${RUNNER}/remove`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jobId }),
        signal: AbortSignal.timeout(SHORT_TIMEOUT_MS),
      });
      const json: any = await r.json().catch(() => null);
      if (!r.ok || !json?.ok) return { ok: false, error: json?.error || `the worker runner answered ${r.status}` };
      return { ok: true, removed: !!json.removed };
    } catch (e: any) {
      return { ok: false, error: `The worker folder could not be removed — ${reasonOf(e)}.` };
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
    // Every field is read out by hand, so a field the runner grew has to be added HERE too or it is
    // silently dropped (the BEA-1389 trap, both ways round).
    return { status, rows: typeof ev.rows === 'number' ? ev.rows : null, error: ev.error ? String(ev.error) : null, waitpointId: ev.waitpointId || null, timedOut: !!ev.timedOut, kitRefused: !!ev.kitRefused, notStarted: !!ev.notStarted };
  }
  return null;
}

function reasonOf(e: any): string {
  if (e?.name === 'TimeoutError') return 'the worker runner did not answer in time';
  return `the worker runner could not be reached (${String(e?.message || e).slice(0, 120)})`;
}
