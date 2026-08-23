import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X, CalendarClock, Wrench, Check, Repeat } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ChatInput } from '../ui/ChatInput';
import { PlanCard, PlanCost } from '../ui/PlanCard';
import { BriefProposalCard } from '../ui/BriefProposalCard';
import { BuilderLine, BuilderMessage } from '../ui/BuilderMessage';

/** What a Social result hands the builder (BEA-1372): the call just made + a compact view of its answer. */
/** `/agent/a/<id>` → `/agent/a/<id>?created=1` — the agent page then offers "Run now" (BEA-1372). */
export function withCreatedFlag(url: string): string {
  if (!url) return url;
  return url.includes('?') ? `${url}&created=1` : `${url}?created=1`;
}

export type BuilderSeed = { tool: string; args: Record<string, any>; label?: string; sample?: { count?: number; listKey?: string; credits?: number; notFound?: boolean; fields?: string[] } };

/**
 * The chat builder (BEA-1104): "＋ New agent" opens a conversation, not a form. The designer
 * interviews, proposes the full spec as a card, and Create builds it. The conversation persists
 * server-side, so you can leave mid-build and come back.
 *
 * With a `seed` (Social → "Make it an agent", BEA-1372) the conversation is started server-side
 * with the builder's own first line about the call just made; "Repeat exactly this call" keeps
 * the pre-filled form one tap away.
 */
export function AgentBuilder({ onCreated, onUseForm, onClose, seed, onSeeded, folderId }: { onCreated: (url: string) => void; onUseForm: () => void; onClose: () => void; seed?: BuilderSeed | null; onSeeded?: () => void; folderId?: string | null }) {
  const toast = useToast();
  const [log, setLog] = useState<BuilderLine[]>([]);
  const [spec, setSpec] = useState<any>(null);
  // The direct-fetch plan with its cost (BEA-1371) — shown instead of the spec when the builder planned one.
  const [plan, setPlan] = useState<any>(null);
  // The brief the conversation wrote (BEA-1424) — a short card here; the brief has its own screen.
  const [brief, setBrief] = useState<any>(null);
  const [cost, setCost] = useState<PlanCost | null>(null);
  const [goal, setGoal] = useState<string | null>(null); // what the result is FOR (BEA-1378) — first line of the plan card
  const [planHidden, setPlanHidden] = useState(false); // "Not now" — the plan stays on the server; the next reply shows it again
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);

  function adopt(d: any) { setLog(d.log || []); setSpec(d.spec || null); setPlan(d.plan || null); setBrief(d.brief || null); setCost(d.cost || null); setGoal(d.goal || null); setPlanHidden(false); }
  const seededRef = useRef(false); // one seed POST per mount — StrictMode runs the effect twice in dev
  useEffect(() => {
    if (seed?.tool) {
      if (seededRef.current) return;
      seededRef.current = true;
      // The hand-off: seed first (a fresh conversation with the builder's line about the call), then read it back.
      // A failed seed is SAID and the URL keeps `sample`, so a reload can try again.
      fetch('/api/agent/builder/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId: seed.tool, args: seed.args || {}, label: seed.label, sample: seed.sample }) })
        .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d?.message || 'Could not start from that call'); adopt(d); onSeeded?.(); })
        .catch((e: any) => setLog([{ who: 'ai', text: `${e?.message || 'Could not start from that call'} — tell me in your own words what the agent should do.` }]));
      return;
    }
    fetch('/api/agent/builder').then((r) => r.json()).then(adopt).catch(() => undefined);
    /* eslint-disable-next-line */
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [log, spec, plan]);

  async function send() {
    const m = msg.trim();
    if (!m || busy) return;
    setBusy(true);
    setLog((p) => [...p, { who: 'you', text: m }]);
    setMsg('');
    try {
      const r = await fetch('/api/agent/builder/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: m }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not reply');
      // The server's row has any 🔎 sample lines the turn wrote BEFORE the reply — re-read it so they land in order (BEA-1372).
      const fresh = await fetch('/api/agent/builder').then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (fresh?.log?.length) setLog(fresh.log); else setLog((p) => [...p, { who: 'ai', text: d.reply }]);
      setSpec(d.spec || null);
      setPlan(d.plan || null);
      setBrief(d.brief || null);
      setCost(d.cost || null);
      setGoal(d.goal || null);
      setPlanHidden(false);
    } catch (e: any) { setLog((p) => [...p, { who: 'ai', text: e?.message || 'Something went wrong — try again.' }]); }
    setBusy(false);
  }

  /** "Change something" — back to the chat: focus the input so the next words go to the builder. */
  function changeSomething() {
    inputRef.current?.querySelector('textarea')?.focus();
  }

  async function create() {
    if ((!spec && !plan && !brief) || creating) return;
    setCreating(true);
    try {
      // Created from inside a folder → the new agent lands in that folder (BEA-1380).
      const r = await fetch('/api/agent/builder/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(folderId ? { folderId } : {}) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not create');
      // A brief builds nothing — it gets a home and opens. Only the old plan road creates an agent.
      toast('success', brief ? 'Ready to read' : 'Agent created 🎉');
      onCreated(brief ? d.url : withCreatedFlag(d.url));
    } catch (e: any) { toast('error', e?.message || 'Could not create'); }
    setCreating(false);
  }

  async function reset() {
    await fetch('/api/agent/builder', { method: 'DELETE' }).catch(() => undefined);
    setLog([]); setSpec(null); setPlan(null); setBrief(null); setCost(null); setGoal(null); setPlanHidden(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={() => !busy && !creating && onClose()}>
      {/* A real conversation deserves a real window (BEA-1251): edge-to-edge on the phone, a large
          tall window on the laptop — not a small card. */}
      <div className="flex h-[calc(var(--vvh,100vh))] w-full flex-col border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900 sm:h-[90vh] sm:max-w-3xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-emerald-600" />New agent — just describe it</h2>
          <div className="flex items-center gap-2">
            {log.length > 0 && <button onClick={reset} className="text-xs text-zinc-400 hover:text-rose-500">Start over</button>}
            <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"><X className="h-5 w-5" /></button>
          </div>
        </div>

        <div className="min-h-[200px] flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {log.length === 0 && (
            <p className="rounded-xl bg-zinc-50 p-3 text-sm text-zinc-500 dark:bg-zinc-800/60">
              Tell me what this agent is for — in your own words. For example: <i>“a daily news agent — tech news and AI news separately, every morning at 7, WhatsApp me the brief.”</i> I'll ask what I need, show you the full plan, and only build it when you press Create.
            </p>
          )}
          {log.map((m, i) => <BuilderMessage key={i} m={m} />)}
          {busy && <div className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />thinking…</div>}

          {/* the plan-with-cost of a direct agent (BEA-1371/1372) */}
          {/* A brief supersedes a plan — the same one-proposal-at-a-time rule the server keeps. */}
          {brief && <BriefProposalCard card={brief} opening={creating} onOpen={create} />}
          {plan && !brief && !spec && !planHidden && <PlanCard plan={plan} cost={cost} goal={goal} creating={creating} onCreate={create} onChange={changeSomething} onDismiss={() => setPlanHidden(true)} />}
          {plan && !spec && planHidden && (
            <button onClick={() => setPlanHidden(false)} className="text-xs text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-300" data-testid="plan-show-again">Show the plan again</button>
          )}

          {/* the evolving proposal */}
          {spec && (
            <div className="rounded-xl border border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">The plan so far</p>
              <div className="mt-1.5 flex items-center gap-2 text-sm font-semibold">{spec.area?.icon || '🤖'} {spec.area?.name}</div>
              {spec.area?.description && <p className="text-xs text-zinc-500">{spec.area.description}</p>}
              <ul className="mt-2 space-y-1">
                {(spec.jobs || []).map((j: any, i: number) => (
                  <li key={i} className="flex items-start gap-1.5 text-sm text-zinc-700 dark:text-zinc-200">
                    <span>{j.icon || '📄'}</span>
                    <span className="min-w-0">
                      <span className="font-medium">{j.name}</span>
                      <span className="ml-1.5 inline-flex items-center gap-1 text-xs text-zinc-500"><CalendarClock className="h-3 w-3" />{j.scheduleText || 'manual'}</span>
                      {j.notifyWhatsApp && <span className="ml-1.5 text-xs text-emerald-600">· WhatsApp</span>}
                    </span>
                  </li>
                ))}
              </ul>
              {(spec.area?.tools || []).length > 0 && (
                <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-zinc-500"><Wrench className="h-3 w-3" />{spec.area.tools.map((t: any) => t.name).join(' · ')}</p>
              )}
              <button onClick={create} disabled={creating} className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Create this agent
              </button>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-zinc-100 p-3 dark:border-zinc-800" ref={inputRef}>
          <ChatInput value={msg} onChange={setMsg} onSend={send} busy={busy} autoFocus placeholder={log.length ? 'Reply…' : 'What should this agent do?'} />
          {seed?.tool ? (
            <button onClick={onUseForm} className="mt-2 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300" data-testid="repeat-exact-call"><Repeat className="h-3 w-3" />Repeat exactly this call — the quick form, pre-filled →</button>
          ) : (
            <button onClick={onUseForm} className="mt-2 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Prefer the quick form? Use it instead →</button>
          )}
        </div>
      </div>
    </div>
  );
}
