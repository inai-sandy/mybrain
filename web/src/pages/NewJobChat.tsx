import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, X, CalendarClock, Check, ListChecks, Wrench } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { DictateButton } from '../ui/DictateButton';
import { Sheet } from '../ui/Sheet';
import { ToolPicker, useCatalog } from '../ui/ToolPicker';

/**
 * The new-job conversation (BEA-1170). "New job" used to open a silent form: starter cards, one
 * box, one AI call, then eight pre-filled fields — it never asked you anything. This asks until it
 * understands, shows the plan, and only builds when you press Create.
 *
 * It lives inside an agent, so it never re-asks what the agent already says about itself.
 */
export function NewJobChat({ areaId, areaName, onCreated, onClose }: { areaId: string; areaName: string; onCreated: (url: string) => void; onClose: () => void }) {
  const toast = useToast();
  const catalog = useCatalog();
  const [log, setLog] = useState<{ who: 'you' | 'ai'; text: string }[]>([]);
  const [job, setJob] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  // The tool step (BEA-1171). `picked` starts as what the chat proposed and becomes whatever you
  // tick — null means "not touched yet", so a fresh proposal can still flow in.
  const [picked, setPickedState] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [pickingTools, setPickingTools] = useState(false);
  // The checks it wrote from your words (BEA-1172) — editable before it builds.
  const [checks, setChecks] = useState<string[]>([]);
  const [checksTouched, setChecksTouched] = useState(false);
  const [newCheck, setNewCheck] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/agent/areas/${areaId}/job-builder`).then((r) => r.json()).then((d) => { setLog(d.log || []); setJob(d.job || null); }).catch(() => undefined);
  }, [areaId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [log, job]);

  // Adopt what the chat proposes — until you touch the list yourself, then yours wins.
  useEffect(() => {
    if (touched) return;
    const ids = Array.isArray(job?.tools) ? job.tools.map((t: any) => (typeof t === 'string' ? t : t?.id)).filter(Boolean) : [];
    setPickedState(ids);
  }, [job, touched]);

  useEffect(() => {
    if (checksTouched) return;
    setChecks(Array.isArray(job?.checks) ? job.checks.map((c: any) => String(c)).filter(Boolean) : []);
  }, [job, checksTouched]);

  async function send() {
    const m = msg.trim();
    if (!m || busy) return;
    setBusy(true);
    setLog((p) => [...p, { who: 'you', text: m }]);
    setMsg('');
    try {
      const r = await fetch(`/api/agent/areas/${areaId}/job-builder/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: m }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not reply');
      setLog((p) => [...p, { who: 'ai', text: d.reply }]);
      setJob(d.job || null);
    } catch (e: any) { setLog((p) => [...p, { who: 'ai', text: e?.message || 'Something went wrong — try again.' }]); }
    setBusy(false);
  }

  async function create() {
    if (!job || creating) return;
    setCreating(true);
    try {
      const r = await fetch(`/api/agent/areas/${areaId}/job-builder/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tools: picked, checks }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not create');
      toast('success', 'Job created 🎉');
      onCreated(d.url);
    } catch (e: any) { toast('error', e?.message || 'Could not create'); }
    setCreating(false);
  }

  async function reset() {
    await fetch(`/api/agent/areas/${areaId}/job-builder`, { method: 'DELETE' }).catch(() => undefined);
    setLog([]); setJob(null);
  }

  const toolName = (id: string) => (catalog?.tools || []).find((t: any) => t.id === id)?.name || id;
  const whyFor = (id: string) => (Array.isArray(job?.tools) ? job.tools : []).find((t: any) => t?.id === id)?.why || '';
  const reasons: { id: string; why: string }[] = (Array.isArray(job?.tools) ? job.tools : [])
    .filter((t: any) => t?.id && t?.why && picked.includes(t.id))
    .map((t: any) => ({ id: t.id, why: String(t.why) }));

  return (
    <Sheet onClose={onClose} size="lg">
      {(close) => (
        <div className="flex max-h-[88vh] flex-col">
          <div className="flex items-start justify-between gap-2 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
            <div className="min-w-0">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-emerald-600" />New job for {areaName}</h2>
              <p className="mt-0.5 text-xs text-zinc-500">Tell it what you want. It will ask what it needs.</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {log.length > 0 && <button onClick={reset} className="text-xs text-zinc-400 hover:text-rose-500">Start over</button>}
              <button onClick={close} aria-label="Close" className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><X className="h-5 w-5" /></button>
            </div>
          </div>

          <div className="min-h-[220px] flex-1 space-y-2 overflow-y-auto px-4 py-3">
            {log.length === 0 && (
              <p className="rounded-xl bg-zinc-50 p-3 text-sm text-zinc-500 dark:bg-zinc-800/60">
                Describe the job in your own words — for example: <i>“every Monday, find what changed in Indian EV battery rules and write me a one-page brief with sources.”</i> I'll ask what I need, show you the plan, and only build it when you press Create.
              </p>
            )}
            {log.map((m, i) => (
              <div key={i} className={'flex ' + (m.who === 'you' ? 'justify-end' : 'justify-start')}>
                <div className={'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-sm ' + (m.who === 'you' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200')}>{m.text}</div>
              </div>
            ))}
            {busy && <div className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />thinking…</div>}

            {job && (
              <div className="rounded-xl border border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">The plan</p>
                <div className="mt-1.5 flex items-center gap-2 text-sm font-semibold">{job.icon || '📄'} {job.name}</div>
                {job.task && <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">{job.task}</p>}
                {job.outcome && <p className="mt-1.5 text-xs text-zinc-500"><b>A good result:</b> {job.outcome}</p>}
                {/* The tool step (BEA-1171): it proposes, you tick. Nothing is picked for you silently. */}
                <div className="mt-2 rounded-lg border border-emerald-200 bg-white/70 p-2 dark:border-emerald-500/20 dark:bg-zinc-900/50">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200"><Wrench className="h-3.5 w-3.5 text-zinc-400" />Tools it will use</span>
                    <button onClick={() => setPickingTools(true)} className="text-xs font-medium text-emerald-600 hover:underline">Change</button>
                  </div>
                  {picked.length === 0 ? (
                    <p className="mt-1 text-xs text-zinc-400">None picked. It will use its own judgment — tap Change to choose.</p>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {picked.map((id) => {
                        const t = (catalog?.tools || []).find((x: any) => x.id === id);
                        const why = whyFor(id);
                        return (
                          <span key={id} title={why || undefined} className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200">
                            {t?.name || id}
                            {t && t.connected === false && <span className="rounded-full bg-amber-100 px-1 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">needs connecting</span>}
                          </span>
                        );
                      })}
                    </div>
                  )}
                  {/* Why it suggested each one — the reason matters more than the name. */}
                  {reasons.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {reasons.map((r) => <li key={r.id} className="text-[11px] text-zinc-500">· <b>{toolName(r.id)}</b> — {r.why}</li>)}
                    </ul>
                  )}
                </div>
                {/* The checks it wrote from what you asked for (BEA-1172) — yours to edit. */}
                <div className="mt-2 rounded-lg border border-emerald-200 bg-white/70 p-2 dark:border-emerald-500/20 dark:bg-zinc-900/50">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700 dark:text-zinc-200"><ListChecks className="h-3.5 w-3.5 text-zinc-400" />What a good result must have</span>
                  {checks.length === 0 ? (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">Nothing to check against yet — add at least one so its results can be graded.</p>
                  ) : (
                    <ul className="mt-1.5 space-y-1">
                      {checks.map((c, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <input
                            value={c}
                            onChange={(e) => { setChecksTouched(true); setChecks((p) => p.map((x, j) => (j === i ? e.target.value : x))); }}
                            className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-xs text-zinc-700 outline-none hover:border-zinc-200 focus:border-emerald-400 dark:text-zinc-200 dark:hover:border-zinc-700"
                          />
                          <button onClick={() => { setChecksTouched(true); setChecks((p) => p.filter((_, j) => j !== i)); }} aria-label="Remove check" className="shrink-0 text-zinc-400 hover:text-rose-500"><X className="h-3.5 w-3.5" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-1.5 flex gap-1.5">
                    <input
                      value={newCheck}
                      onChange={(e) => setNewCheck(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && newCheck.trim()) { setChecksTouched(true); setChecks((p) => [...p, newCheck.trim()]); setNewCheck(''); } }}
                      placeholder="Add another…"
                      className="min-w-0 flex-1 rounded border border-zinc-200 bg-transparent px-2 py-1 text-xs outline-none focus:border-emerald-400 dark:border-zinc-700"
                    />
                    <button
                      onClick={() => { if (newCheck.trim()) { setChecksTouched(true); setChecks((p) => [...p, newCheck.trim()]); setNewCheck(''); } }}
                      disabled={!newCheck.trim()}
                      className="shrink-0 rounded border border-zinc-300 px-2 text-xs disabled:opacity-40 dark:border-zinc-700"
                    >Add</button>
                  </div>
                </div>
                <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500"><CalendarClock className="h-3 w-3" />{job.scheduleText || 'only when you press Run'}</p>
                <button onClick={create} disabled={creating} className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Create this job
                </button>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {pickingTools && (
            <ToolPicker
              value={picked}
              onSave={(ids) => { setPickedState(ids); setTouched(true); }}
              onClose={() => setPickingTools(false)}
              title="Tools for this job"
              subtitle="It suggested these. Tick what it may use — it gets nothing else."
            />
          )}

          <div className="border-t border-zinc-100 p-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <input
                  value={msg}
                  onChange={(e) => setMsg(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && send()}
                  autoFocus
                  placeholder={log.length ? 'Reply…' : 'What should this job do?'}
                  className="w-full rounded-xl border border-zinc-200 bg-transparent px-3 py-2.5 pr-11 text-base outline-none focus:border-emerald-400 dark:border-zinc-700 sm:text-sm"
                />
                <DictateButton onText={(t) => setMsg((p) => (p ? p + ' ' : '') + t)} className="absolute right-2 top-1/2 -translate-y-1/2" />
              </div>
              <button onClick={send} disabled={busy || !msg.trim()} aria-label="Send" className="shrink-0 rounded-xl bg-emerald-600 p-2.5 text-white hover:bg-emerald-500 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</button>
            </div>
          </div>
        </div>
      )}
    </Sheet>
  );
}
