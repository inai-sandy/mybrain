/**
 * Plain-English schedule builder (BEA-1075) — dropdowns in, one honest sentence out.
 * There is no cron anywhere in My Brain (the engine's schedule shape is already human-sized),
 * so there is nothing to hide behind an "Advanced" flap.
 */
export type Sched = { every: 'day' | 'weekday' | 'week' | 'hour'; at?: string; dow?: number; minute?: number } | null;

export function schedSentence(s: Sched): string {
  if (!s) return 'Runs only when you press Run.';
  if (s.every === 'day') return `Runs every day at ${s.at || '07:00'}.`;
  if (s.every === 'weekday') return `Runs every weekday at ${s.at || '07:00'}.`;
  if (s.every === 'week') return `Runs every Sunday at ${s.at || '08:00'}.`;
  if (s.every === 'hour') return `Runs every hour at :${String(s.minute ?? 0).padStart(2, '0')}.`;
  return 'Runs only when you press Run.';
}

export function schedText(s: Sched): string | null {
  if (!s) return null;
  if (s.every === 'day') return `Every day at ${s.at || '07:00'}`;
  if (s.every === 'weekday') return `Every weekday at ${s.at || '07:00'}`;
  if (s.every === 'week') return `Every Sunday at ${s.at || '08:00'}`;
  if (s.every === 'hour') return `Every hour at :${String(s.minute ?? 0).padStart(2, '0')}`;
  return null;
}

export function SchedulePicker({ value, onChange }: { value: Sched; onChange: (s: Sched) => void }) {
  const every = value?.every || 'manual';
  const at = value?.at || '07:00';
  const set = (e: string, newAt = at) => {
    if (e === 'manual') return onChange(null);
    if (e === 'hour') return onChange({ every: 'hour', minute: Number(newAt.split(':')[1]) || 0 });
    if (e === 'week') return onChange({ every: 'week', dow: 0, at: newAt });
    onChange({ every: e as any, at: newAt });
  };
  const sel = 'rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select value={every} onChange={(e) => set(e.target.value)} className={sel}>
          <option value="manual">Only when I press Run</option>
          <option value="day">Every day</option>
          <option value="weekday">Every weekday</option>
          <option value="week">Every Sunday</option>
          <option value="hour">Every hour</option>
        </select>
        {every !== 'manual' && every !== 'hour' && <input type="time" value={at} onChange={(e) => set(every, e.target.value)} className={sel} />}
        {every === 'hour' && (
          <span className="flex items-center gap-1 text-sm text-zinc-500">at minute
            <input type="number" min={0} max={59} value={value?.minute ?? 0} onChange={(e) => onChange({ every: 'hour', minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} className={sel + ' w-16'} />
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-400">{schedSentence(value)}</p>
    </div>
  );
}
