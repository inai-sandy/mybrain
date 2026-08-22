import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';

/**
 * "Gmail calls today 3 / 60 · next read 21:00 today" — the counter behind the owner's Composio
 * quota, read from the server (BEA-1399). With `editable` (Settings) the cap can be changed.
 */
export type GmailUsage = {
  day: string;
  tz: string;
  calls: number;
  cap: number;
  byAction: { action: string; n: number }[];
  last: string | null;
  schedule: { early: string; final: string };
  next: { time: string; day: 'today' | 'tomorrow' };
};

export function GmailUsageLine({ editable = false, className = '' }: { editable?: boolean; className?: string }) {
  const [u, setU] = useState<GmailUsage | null>(null);
  const [cap, setCap] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/google/gmail/usage');
      if (!r.ok) return;
      const d = (await r.json()) as GmailUsage;
      if (d && typeof d.calls === 'number') {
        setU(d);
        setCap(String(d.cap));
      }
    } catch {
      /* no line */
    }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    const n = Number(cap);
    if (!Number.isFinite(n) || n < 0) { setErr('A whole number of calls per day (0 = no cap).'); return; }
    setSaving(true);
    setErr(null);
    try {
      const r = await fetch('/api/google/gmail/cap', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cap: Math.floor(n) }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.message || 'Could not save the cap');
      setU((p) => (p ? { ...p, cap: d.cap } : p));
      setCap(String(d.cap));
    } catch (e: any) {
      setErr(e?.message || 'Could not save the cap');
    } finally {
      setSaving(false);
    }
  }

  if (!u) return null;
  const capText = u.cap > 0 ? String(u.cap) : 'no cap';
  const over = u.cap > 0 && u.calls >= u.cap;
  const what = u.byAction.length ? u.byAction.map((a) => `${a.n}× ${a.action.replace(/_/g, ' ')}`).join(' · ') : 'none yet';

  return (
    <div data-testid="gmail-usage" className={'text-xs ' + className}>
      <div className={'inline-flex flex-wrap items-center gap-x-2 gap-y-1 ' + (over ? 'text-amber-600' : 'text-zinc-500')} title={`${u.day} (${u.tz}) · ${what}`}>
        <Gauge size={13} className="shrink-0" />
        <span>
          Gmail calls today: <b className={over ? 'text-amber-600' : 'text-zinc-700 dark:text-zinc-200'}>{u.calls}</b> / {capText}
        </span>
        <span aria-hidden>·</span>
        <span>next read {u.next.time} {u.next.day}</span>
        <span aria-hidden>·</span>
        <span>reads at {u.schedule.early} and {u.schedule.final}, nothing in between</span>
      </div>
      {editable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label htmlFor="gmail-cap" className="text-zinc-500">Daily cap</label>
          <input
            id="gmail-cap"
            type="number"
            min={0}
            inputMode="numeric"
            value={cap}
            onChange={(e) => setCap(e.target.value)}
            className="w-24 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-sm"
          />
          <button onClick={save} disabled={saving} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-2.5 py-1 text-xs hover:border-blue-500 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
          <span className="text-zinc-400">0 = no cap. Past the cap, Gmail is not called until midnight.</span>
          {err && <span className="text-red-500">{err}</span>}
        </div>
      )}
    </div>
  );
}
