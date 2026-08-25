import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, X } from 'lucide-react';
import { useGoBack } from '../ui/useGoBack';
import { useToast } from '../ui/Toast';
import { Brief, BriefRefusal, BriefView, SectionKey } from '../ui/BriefView';
import { TrialCard, TrialState } from '../ui/TrialCard';
import { Goal, GoalView } from '../ui/GoalView';

/**
 * The brief screen (BEA-1406, "Brief First") — the first of the two gates between an idea and a
 * live agent.
 *
 * Before this, the only thing he could approve was a description typed in a chat. A description can
 * say anything; the eight-box form behind it silently dropped whatever it had no box for. Here he
 * reads what will actually be built, sees which parts are his and which the AI made up, changes
 * anything, and crosses out what he does not want — and the server refuses to accept a brief that
 * still has a hole in it, with the reason printed beside the hole.
 */
export default function AgentBriefPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const goBack = useGoBack('/agent');
  const toast = useToast();
  const [brief, setBrief] = useState<Brief | null>(null);
  const [refusals, setRefusals] = useState<BriefRefusal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [area, setArea] = useState<any>(null);
  const [proof, setProof] = useState<any | null>(null);
  // The second gate (BEA-1408): the real run he judges before anything can be created.
  const [trial, setTrial] = useState<TrialState | null>(null);
  // THE GOAL (BEA-1463) — what Codex says it is going to build, for him to approve. This is what
  // replaces the brief below it: the brief is the app's reading of his conversation, and he asked
  // for that to stop. Both are shown while the new road is being finished, so nothing he already
  // relies on disappears underneath him mid-build.
  const [goal, setGoal] = useState<Goal | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadGoal = useCallback(async () => {
    try {
      const r = await fetch(`/api/agent/areas/${id}/goal`);
      setGoal(r.ok ? await r.json() : null);
    } catch { setGoal(null); }
  }, [id]);

  const goalDo = useCallback(async (path: string, body?: any) => {
    setGoalBusy(true);
    try {
      const r = await fetch(`/api/agent/areas/${id}/goal${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'That did not work');
      setGoal(d);
    } catch (e: any) {
      toast('error', e?.message || 'That did not work');
    } finally {
      setGoalBusy(false);
    }
  }, [id, toast]);

  const take = useCallback((d: any) => {
    if (!d?.brief) return;
    setBrief(d.brief);
    setRefusals(Array.isArray(d.refusals) ? d.refusals : []);
  }, []);

  const loadTrial = useCallback(async () => {
    const d = await fetch(`/api/agent/areas/${id}/brief/trial`).then((r) => r.json()).catch(() => null);
    if (d && typeof d === 'object' && !d.statusCode) setTrial(d);
    return d;
  }, [id]);

  const load = useCallback(async () => {
    setLoading(true);
    const [b, a] = await Promise.all([
      fetch(`/api/agent/areas/${id}/brief`).then((r) => r.json()).catch(() => null),
      fetch(`/api/agent/areas/${id}`).then((r) => r.json()).catch(() => null),
    ]);
    take(b);
    setArea(a);
    await loadTrial();
    setLoading(false);
  }, [id, take, loadTrial]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadGoal(); }, [loadGoal]);

  // A build turn is a real Codex session and takes minutes, so the screen polls rather than holding
  // a request open. The poll stops the moment it settles — never a timer left running.
  useEffect(() => {
    if (!trial?.running) { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } return; }
    if (pollRef.current) return;
    pollRef.current = setInterval(() => { loadTrial(); }, 4000);
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, [trial?.running, loadTrial]);

  /** Every call answers the whole brief, so the screen can never show half of a change. */
  async function send(path: string, body?: any, method = 'POST') {
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/areas/${id}/brief${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { toast('error', d?.message || 'That did not save.'); return null; }
      take(d);
      return d;
    } catch {
      toast('error', 'That did not save — check your connection.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openProof(callId: string) {
    const d = await fetch(`/api/agent/areas/${id}/brief/proof/${callId}`).then((r) => r.json()).catch(() => null);
    if (!d || d.statusCode) { toast('error', 'That look is not on record any more.'); return; }
    setProof(d);
  }

  async function trialPost(path: string, body?: any) {
    setBusy(true);
    try {
      const r = await fetch(`/api/agent/areas/${id}/brief/trial${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { toast('error', d?.message || 'That did not work.'); return null; }
      return d;
    } catch {
      toast('error', 'That did not work — check your connection.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function runTrial() {
    const d = await trialPost('/run');
    if (d) setTrial(d);
  }

  async function createIt() {
    const d = await trialPost('/create');
    if (!d) return;
    if (d.ok) { toast('success', 'Kept. It is yours now.'); navigate(`/agent/a/${d.agentId}?created=1`); }
    else toast('error', d.whyNot || 'Not yet.');
  }

  async function sendBack(note: string) {
    const d = await trialPost('/send-back', { note });
    if (d) { setTrial(d); await load(); toast('success', 'Sent back. Change what you need, then run it again.'); }
  }

  async function approve() {
    setApproving(true);
    try {
      const d = await send('/approve');
      if (d?.ok) { toast('success', 'Approved. Now run it once and see what it really does.'); await loadTrial(); }
    } finally {
      setApproving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!brief) {
    return (
      <div className="space-y-4">
        <button onClick={goBack} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Agents</button>
        <p className="text-sm text-zinc-500">There is no brief for this agent yet.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 pb-4">
      <button onClick={goBack} className="inline-flex min-h-[32px] items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
        <ArrowLeft className="h-4 w-4" />{area?.name || 'Agents'}
      </button>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">The brief</h1>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">version {brief.version}</span>
          {brief.status === 'approved' && (
            <span data-testid="status-approved" className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300">approved</span>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {trial?.trial?.status === 'passed'
            ? 'Look at what it actually did, below. Nothing has been kept yet.'
            : <>Read this before anything is built. Anything marked <span className="font-semibold text-amber-700 dark:text-amber-300">my guess</span> is the AI's own idea, not yours — change it or cross it out.</>}
        </p>
      </header>

      {/*
        The result leads (BEA-1416). A brief is a document and documents get skimmed at 11pm; a
        result gets looked at, because a wrong message is obvious in a way that line eleven of a
        document never is. So when there is something real to judge, it goes above everything else
        and the brief moves below it — still there, still editable.
      */}
      {brief.status === 'approved' && trial && (
        <TrialCard
          state={trial}
          busy={busy}
          onRun={runTrial}
          onCreate={createIt}
          onSendBack={sendBack}
        />
      )}

      {trial?.trial?.status === 'passed' && (
        <p className="text-[11px] text-zinc-400">The brief it was built from is below, if you want to change something.</p>
      )}

      {(goal || null) && (
        <section className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-700 dark:bg-zinc-900" data-testid="goal-panel">
          <GoalView
            goal={goal}
            busy={goalBusy}
            onApprove={() => goalDo('/approve')}
            onSendBack={(note) => goalDo('/send-back', { note })}
            onAnswer={(text) => goalDo('/answer', { text })}
          />
        </section>
      )}

      <BriefView
        brief={brief}
        refusals={refusals}
        busy={busy}
        approving={approving}
        onEdit={(lineId, text) => send(`/line/${lineId}`, { text }, 'PATCH')}
        onStrike={(lineId, struck) => send(`/line/${lineId}/strike`, { struck })}
        onAdd={(k: SectionKey, text) => send('/line', { section: k, text, origin: 'owner' })}
        onMessage={(text) => send('', { delivery: { ...brief.delivery, messageText: text } })}
        onApprove={approve}
        onProof={openProof}
      />

      {proof && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => setProof(null)}>
          <div
            data-testid="proof-sheet"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl dark:bg-zinc-900"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">What came back</h2>
                <p className="truncate text-[11px] text-zinc-500">{proof.actionId}{proof.at ? ` · ${new Date(proof.at).toLocaleString()}` : ''}</p>
              </div>
              <button onClick={() => setProof(null)} aria-label="Close" className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X className="h-4 w-4" /></button>
            </div>
            {!proof.ok && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">It did not work: {proof.error || 'no reason recorded'}</p>}
            {proof.args && (
              <>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What was asked</p>
                <pre className="mt-1 overflow-x-auto rounded-md bg-zinc-50 p-2 text-[11px] leading-snug dark:bg-zinc-800">{typeof proof.args === 'string' ? proof.args : JSON.stringify(proof.args, null, 2)}</pre>
              </>
            )}
            {proof.result && (
              <>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What came back</p>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-zinc-50 p-2 text-[11px] leading-snug dark:bg-zinc-800">{proof.result}</pre>
                <p className="mt-1 text-[11px] text-zinc-400">Only the first part is kept — enough to check it was real.</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
