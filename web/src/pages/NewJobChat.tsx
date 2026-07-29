import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, X, CalendarClock, Check, ListChecks, Wrench } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { DictateButton } from '../ui/DictateButton';
import { Sheet } from '../ui/Sheet';
import { useCatalog } from '../ui/ToolPicker';

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
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/agent/areas/${areaId}/job-builder`).then((r) => r.json()).then((d) => { setLog(d.log || []); setJob(d.job || null); }).catch(() => undefined);
  }, [areaId]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [log, job]);

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
      const r = await fetch(`/api/agent/areas/${areaId}/job-builder/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
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
                {Array.isArray(job.tools) && job.tools.length > 0 && (
                  <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs text-zinc-500">
                    <Wrench className="h-3 w-3" />{job.tools.map((t: any) => toolName(typeof t === 'string' ? t : t?.id)).join(' · ')}
                  </p>
                )}
                {Array.isArray(job.checks) && job.checks.length > 0 && (
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-xs text-zinc-500"><ListChecks className="h-3 w-3" />{job.checks.length} check{job.checks.length === 1 ? '' : 's'}</p>
                )}
                <p className="mt-1 flex items-center gap-1 text-xs text-zinc-500"><CalendarClock className="h-3 w-3" />{job.scheduleText || 'only when you press Run'}</p>
                <button onClick={create} disabled={creating} className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                  {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}Create this job
                </button>
              </div>
            )}
            <div ref={endRef} />
          </div>

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
