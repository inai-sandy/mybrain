import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, X, CalendarClock, Wrench, Check } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ChatInput } from '../ui/ChatInput';

/**
 * The chat builder (BEA-1104): "＋ New agent" opens a conversation, not a form. The designer
 * interviews, proposes the full spec as a card, and Create builds it. The conversation persists
 * server-side, so you can leave mid-build and come back.
 */
export function AgentBuilder({ onCreated, onUseForm, onClose }: { onCreated: (url: string) => void; onUseForm: () => void; onClose: () => void }) {
  const toast = useToast();
  const [log, setLog] = useState<{ who: 'you' | 'ai'; text: string }[]>([]);
  const [spec, setSpec] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/agent/builder').then((r) => r.json()).then((d) => { setLog(d.log || []); setSpec(d.spec || null); }).catch(() => undefined);
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [log, spec]);

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
      setLog((p) => [...p, { who: 'ai', text: d.reply }]);
      setSpec(d.spec || null);
    } catch (e: any) { setLog((p) => [...p, { who: 'ai', text: e?.message || 'Something went wrong — try again.' }]); }
    setBusy(false);
  }

  async function create() {
    if (!spec || creating) return;
    setCreating(true);
    try {
      const r = await fetch('/api/agent/builder/create', { method: 'POST' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.message || 'Could not create');
      toast('success', 'Agent created 🎉');
      onCreated(d.url);
    } catch (e: any) { toast('error', e?.message || 'Could not create'); }
    setCreating(false);
  }

  async function reset() {
    await fetch('/api/agent/builder', { method: 'DELETE' }).catch(() => undefined);
    setLog([]); setSpec(null);
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
          {log.map((m, i) => (
            <div key={i} className={'flex ' + (m.who === 'you' ? 'justify-end' : 'justify-start')}>
              <div className={'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-1.5 text-sm ' + (m.who === 'you' ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200')}>{m.text}</div>
            </div>
          ))}
          {busy && <div className="flex items-center gap-2 text-xs text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" />thinking…</div>}

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

        <div className="border-t border-zinc-100 p-3 dark:border-zinc-800">
          <ChatInput value={msg} onChange={setMsg} onSend={send} busy={busy} autoFocus placeholder={log.length ? 'Reply…' : 'What should this agent do?'} />
          <button onClick={onUseForm} className="mt-2 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">Prefer the quick form? Use it instead →</button>
        </div>
      </div>
    </div>
  );
}
