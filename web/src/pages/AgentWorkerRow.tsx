import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Hammer, Loader2, Sparkles, Wrench } from 'lucide-react';

/**
 * The **Worker** row of the job's Settings accordion (BEA-1394, agent workers 9/10 —
 * `specs/AGENT-WORKERS.md` §J), in the BEA-1381 layout: a summary line when closed, the whole story
 * when open.
 *
 * What it shows, in the order the owner asks it:
 *  • which version is live and when it was built, and whether its tests passed;
 *  • the **switch** — run this job on its worker, or run it the old way. Off by default and never
 *    turned on by anything but this tap; turning it off is instant and needs no rebuild;
 *  • what the NEXT run will really do, in the server's own words (the same function that dispatches);
 *  • what "it worked" means, reusing the contract lines BEA-1391 already renders — never a second copy;
 *  • staleness ("the plan changed since v2 was built") with **Rebuild**;
 *  • a worker built against an OLDER parts box than the server's (BEA-1461) — said in its own words
 *    and its own colour, because it is not staleness: the plan is right, the program is correct and
 *    still runs, it simply predates tools that were added since;
 *  • the repair history, and the accept/decline buttons for a repair held back by the promotion guard;
 *  • what the last run cost — credits and AI tokens.
 */

export type WorkerBuild = {
  id: string;
  version: number;
  status: string;
  origin: string;
  cause?: string | null;
  reason?: string | null;
  tests?: { passed: number; failed: number } | null;
  error?: string | null;
  stale?: boolean;
  startedAt: string;
  finishedAt?: string | null;
};

export type RunCost = { credits: number; aiTokens: number; calls: number };

export type WorkerState = {
  agentId: string;
  worker: WorkerBuild | null;
  held?: WorkerBuild | null;
  repairing?: boolean;
  stale: boolean;
  /** Built against an older kit than the server's — separate from `stale` on purpose (BEA-1461). */
  partsBoxOld?: boolean;
  partsBoxNote?: string;
  compilable: boolean;
  reason?: string;
  building: boolean;
  builds: WorkerBuild[];
  /** The dispatch switch (BEA-1394) — the job's own `useWorker`. */
  useWorker?: boolean;
  /** What the next run really does, decided by the same code that dispatches it. */
  road?: { use: boolean; say?: string; version?: number };
  lastRun?: { id: string; status: string; runKind?: string; startedAt: string; cost?: RunCost } | null;
};

const dt = (v?: string | null) => (v ? new Date(v).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const day = (v?: string | null) => (v ? new Date(v).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');

/** "v3 · built 22 Aug · 8 tests passed · running its worker" — or the honest words when there is none. */
export function workerSummary(w: WorkerState | null): string {
  if (!w) return 'Checking…';
  if (!w.compilable) return 'Not for this job — it runs on the engine';
  if (w.building) return 'Building a worker now…';
  if (!w.worker) return 'No worker yet · runs the old way';
  const tests = w.worker.tests ? `${w.worker.tests.passed} test${w.worker.tests.passed === 1 ? '' : 's'} passed` : 'no test record';
  const road = w.useWorker ? (w.road?.use ? 'running its worker' : 'falling back to the old way') : 'running the old way';
  return `v${w.worker.version} · built ${day(w.worker.finishedAt || w.worker.startedAt)} · ${tests}${w.stale ? ' · out of date' : ''} · ${road}`;
}

/** Credits + AI tokens for one run, in the owner's words. "nothing yet" is a real answer. */
export function costLine(cost?: RunCost | null): string {
  if (!cost) return 'nothing recorded';
  const credits = `${cost.credits} credit${cost.credits === 1 ? '' : 's'}`;
  const tokens = cost.aiTokens > 0 ? ` · ${cost.aiTokens >= 1000 ? `${Math.round(cost.aiTokens / 1000)}k` : cost.aiTokens} AI tokens` : ' · no AI cost';
  const calls = cost.calls ? ` · ${cost.calls} call${cost.calls === 1 ? '' : 's'}` : '';
  return credits + tokens + calls;
}

export function WorkerRow({ agentId, worker: w, contractWords, reload, toast }: {
  agentId: string;
  /** The job's worker state, owned by the page so the CLOSED row can summarise it too. */
  worker: WorkerState | null;
  /** The contract in plain words, already fetched by the job page (BEA-1391) — reused, never re-derived. */
  contractWords: string[] | null;
  reload: () => Promise<any>;
  toast: (kind: 'success' | 'error', msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  const load = useCallback(() => reload(), [reload]);

  // While a build or a repair is going, keep the row honest without a refresh.
  useEffect(() => {
    const live = !!(w?.building || w?.repairing);
    if (live && !poll.current) poll.current = setInterval(() => void load(), 5000);
    if (!live && poll.current) { clearInterval(poll.current); poll.current = null; }
    return () => { if (poll.current) { clearInterval(poll.current); poll.current = null; } };
  }, [w?.building, w?.repairing, load]);

  async function build() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/agents/${agentId}/worker/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'The build could not be started');
      if (d?.built?.ok) toast('success', `Worker v${d.built.version} is live — ${d.built.tests?.passed || 0} tests passed`);
      else toast('error', d?.built?.error || 'The build did not pass its tests — nothing changed');
    } catch (e: any) {
      toast('error', e?.message || 'The build could not be started');
    } finally {
      setBusy(false);
      load();
    }
  }

  /**
   * Put an older version back (BEA-1506).
   *
   * The server moves the disk and the record together — that is the whole point of the route, and why
   * nothing here touches either itself. Moving one without the other is how the app and the runner
   * end up disagreeing about which version is live.
   */
  async function rollback(version: number) {
    if (busy) return;
    if (!confirm(`Put v${version} back? Every run from now on uses it.`)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/agents/${agentId}/worker/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d?.rolledBack?.ok === false) throw new Error(d?.rolledBack?.error || d?.message || 'Could not put it back');
      toast('success', `v${version} is live again`);
    } catch (e: any) {
      toast('error', e?.message || 'Could not put it back');
    } finally {
      setBusy(false);
      load();
    }
  }

  async function setUseWorker(on: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/agents/${agentId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ useWorker: on }) });
      if (!r.ok) throw new Error('Could not save that');
      toast('success', on ? 'It will run on its worker from the next run' : 'Back to the old way — from the next run');
      await load();
    } catch (e: any) {
      toast('error', e?.message || 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  async function decide(buildId: string, yes: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/agents/${agentId}/worker/repairs/${buildId}/${yes ? 'accept' : 'decline'}`, { method: 'POST' });
      if (!r.ok) throw new Error('Could not do that');
      toast('success', yes ? 'The repair is live' : 'The repair was left alone — the worker is unchanged');
      await load();
    } catch (e: any) {
      toast('error', e?.message || 'Could not do that');
    } finally {
      setBusy(false);
    }
  }

  if (!w) return <p className="text-[11px] text-zinc-400">Checking this job’s worker…</p>;
  if (!w.compilable) return <p className="text-sm text-zinc-500 dark:text-zinc-400" data-testid="worker-not-compilable">{w.reason || 'This job runs on the engine, so there is nothing to compile into a worker.'}</p>;

  const repairs = (w.builds || []).filter((b) => b.origin === 'repair');
  const shown = showAll ? w.builds : (w.builds || []).slice(0, 3);

  return (
    <div className="flex flex-col gap-3" data-testid="worker-row">
      {/* 1 · what is live */}
      <div className="rounded-xl border border-zinc-100 bg-zinc-50 px-3 py-2.5 dark:border-zinc-800 dark:bg-zinc-800/50">
        {w.worker ? (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-semibold" data-testid="worker-version">Worker v{w.worker.version}</span>
              <span className="text-[11px] text-zinc-500">built {dt(w.worker.finishedAt || w.worker.startedAt)}</span>
              {w.worker.tests ? (
                <span className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ' + (w.worker.tests.failed ? 'bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300')} data-testid="worker-tests">
                  <CheckCircle2 className="h-3 w-3" />{w.worker.tests.passed} passed{w.worker.tests.failed ? ` · ${w.worker.tests.failed} failed` : ''}
                </span>
              ) : (
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-zinc-800">no test record</span>
              )}
            </div>
            <p className="mt-1 text-[11px] text-zinc-400">Codex compiled this from the plan above and it only went live because its own tests passed against saved answers.</p>
          </>
        ) : (
          <p className="text-sm text-zinc-600 dark:text-zinc-300" data-testid="worker-none">No worker has been built for this job yet. It runs the old way — the plan runner — exactly as it always has.</p>
        )}
      </div>

      {/* 2 · stale */}
      {w.stale && (
        <p className="flex items-start gap-1.5 text-[11px] font-medium text-amber-600 dark:text-amber-400" data-testid="worker-stale">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Your plan changed since v{w.worker?.version} was built, so this worker is out of date. Rebuild it to use it again — until then this job runs the old way.</span>
        </p>
      )}

      {/* 2b · built against an older parts box (BEA-1461) — NOT the same thing as stale.
              Stale says "the plan changed, so this program no longer does what the job says" and is
              a reason to distrust it. This says "the plan is exactly right, and there are tools it
              was never told about" — it still runs correctly, it is just missing what came later.
              Blue, not amber: nothing is wrong, something is available. */}
      {w.partsBoxOld && !w.stale && (
        <p className="flex items-start gap-1.5 text-[11px] font-medium text-sky-700 dark:text-sky-300" data-testid="worker-parts-box">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{w.partsBoxNote}</span>
        </p>
      )}

      {/* 3 · the switch (the dispatch switch — nothing else ever turns it on) */}
      <label className="flex cursor-pointer items-center justify-between gap-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <span className="min-w-0">
          <span className="block text-sm font-semibold">Run this job on its worker</span>
          <span className="block text-[11px] text-zinc-400">
            {w.useWorker
              ? 'On. Turn it off to run it the old way again — that takes effect on the next run and needs no rebuild.'
              : 'Off — it runs the old way, on the plan runner. Nothing ever switches this on by itself.'}
          </span>
        </span>
        <input type="checkbox" data-testid="worker-use" checked={!!w.useWorker} disabled={busy || (!w.worker && !w.useWorker)}
          onChange={(e) => setUseWorker(e.target.checked)} className="h-5 w-9 shrink-0 accent-emerald-600 disabled:opacity-40" />
      </label>
      {!w.worker && !w.useWorker && <p className="-mt-1 text-[11px] text-zinc-400">Build a worker first, then this switch turns on.</p>}
      {w.useWorker && (
        <p className={'text-[11px] ' + (w.road?.use ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400')} data-testid="worker-road">
          {w.road?.use ? `Next run: on worker v${w.road.version}.` : w.road?.say || 'Next run: the old way.'}
        </p>
      )}

      {/* 4 · what counts as a good run — the same lines Settings already shows (BEA-1391) */}
      {contractWords && contractWords.length > 0 && (
        <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold">What this worker must produce</h3>
          <ul className="mt-1.5 space-y-1" data-testid="worker-contract">
            {contractWords.map((line, i) => (
              <li key={i} className="flex gap-2 text-[13px] text-zinc-600 dark:text-zinc-300"><span className="text-emerald-600 dark:text-emerald-400">✓</span><span>{line}</span></li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-zinc-400">Checked before anything is written. A run that does not pass fails out loud and writes nothing.</p>
        </div>
      )}

      {/* 5 · a repair the promotion guard held back for you (BEA-1393) */}
      {w.held && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10" data-testid="worker-held">
          <p className="text-[13px] font-medium text-amber-900 dark:text-amber-100">A repair (v{w.held.version}) passed its tests but changes what this job returns, so it was NOT put live.</p>
          {w.held.error && <p className="mt-1 text-[11px] text-amber-800/80 dark:text-amber-200/70">{w.held.error}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => decide(w.held!.id, true)} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Put it live</button>
            <button disabled={busy} onClick={() => decide(w.held!.id, false)} className="rounded-lg bg-white px-3 py-1.5 text-sm font-medium ring-1 ring-amber-300 hover:bg-amber-100 disabled:opacity-50 dark:bg-zinc-800 dark:ring-amber-500/30 dark:hover:bg-zinc-700">Leave it alone</button>
          </div>
        </div>
      )}

      {/* 6 · what the last run cost (BEA-1394 §I — neither road showed a total before this) */}
      <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <h3 className="text-sm font-semibold">What the last run cost</h3>
        {w.lastRun ? (
          <p className="mt-1 text-[13px] text-zinc-600 dark:text-zinc-300" data-testid="worker-last-cost">
            {dt(w.lastRun.startedAt)} · {w.lastRun.status} · {costLine(w.lastRun.cost)}
            {w.lastRun.runKind === 'worker' ? ' · on its worker' : w.lastRun.runKind === 'plan' ? ' · the old way' : ''}
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-zinc-400">It has not run yet.</p>
        )}
      </div>

      {/* 7 · build history + repairs */}
      {(w.builds || []).length > 0 && (
        <div className="border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <h3 className="text-sm font-semibold">Builds and repairs <span className="font-normal text-zinc-400">({w.builds.length}{repairs.length ? `, ${repairs.length} repair${repairs.length === 1 ? '' : 's'}` : ''})</span></h3>
          <ul className="mt-1.5 space-y-1.5" data-testid="worker-history">
            {shown.map((b) => (
              <li key={b.id} className="flex items-start gap-2 text-[12px] text-zinc-600 dark:text-zinc-300">
                <span className="mt-0.5 shrink-0">{b.origin === 'repair' ? <Wrench className="h-3.5 w-3.5 text-amber-500" /> : <Hammer className="h-3.5 w-3.5 text-zinc-400" />}</span>
                <span className="min-w-0">
                  <span className="font-medium">v{b.version || '—'} {b.origin === 'repair' ? 'repair' : b.origin}</span>
                  {' · '}{b.status}
                  {b.tests ? ` · ${b.tests.passed} passed${b.tests.failed ? `, ${b.tests.failed} failed` : ''}` : ''}
                  {' · '}{dt(b.finishedAt || b.startedAt)}
                  {b.error && <span className="block text-[11px] text-zinc-400">{b.error}</span>}
                  {b.cause && b.origin === 'repair' && <span className="block text-[11px] text-zinc-400">what broke: {b.cause}</span>}
                  {/* PUT AN OLDER VERSION BACK (BEA-1506). The route existed (BEA-1494) and nothing
                      called it, so restoring a working version meant a terminal. Offered only on a
                      version that really was built and is not the one already live — putting the live
                      version "back" is a no-op dressed up as a choice. */}
                  {b.version && b.version !== w.worker?.version && (b.status === 'promoted' || b.status === 'held') && (
                    <button
                      type="button"
                      disabled={busy}
                      data-testid={`rollback-v${b.version}`}
                      onClick={() => rollback(b.version!)}
                      className="mt-1 rounded-lg border border-zinc-200 px-2 py-0.5 text-[11px] font-medium text-zinc-600 hover:border-emerald-400 hover:text-emerald-700 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:text-emerald-300"
                    >Put v{b.version} back</button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {w.builds.length > 3 && (
            <button type="button" onClick={() => setShowAll((p) => !p)} className="mt-1.5 text-[11px] font-medium text-emerald-600 hover:underline dark:text-emerald-400">
              {showAll ? 'Show fewer' : `Show all ${w.builds.length}`}
            </button>
          )}
        </div>
      )}

      {/* 8 · build / rebuild */}
      <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <button type="button" disabled={busy || w.building} onClick={build} data-testid="worker-build"
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          {(busy || w.building) ? <Loader2 className="h-4 w-4 animate-spin" /> : <Hammer className="h-4 w-4" />}
          {w.building ? 'Building…' : w.worker ? 'Rebuild' : 'Build a worker'}
        </button>
        {w.repairing && <span className="text-[11px] text-amber-600 dark:text-amber-400">A repair is running…</span>}
      </div>
      <p className="text-[11px] text-zinc-400">A build takes a few minutes: Codex compiles the plan above into a small program and it only goes live if its own tests pass. Nothing changes while it builds, and a build that fails leaves this job exactly where it is.</p>
    </div>
  );
}
