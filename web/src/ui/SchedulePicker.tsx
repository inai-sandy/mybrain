/**
 * Plain-English schedule builder (BEA-1075) + event triggers (BEA-1076) — dropdowns in, one honest
 * sentence out. There is no cron anywhere in My Brain (the engine's schedule shape is already
 * human-sized), so there is nothing to hide behind an "Advanced" flap.
 */
export type Sched =
  | { every: 'day' | 'weekday' | 'week' | 'hour'; at?: string; dow?: number; minute?: number }
  | { event: 'journal.added' | 'whatsapp.reply' | 'bookmark.added' }
  | null;

const EVENT_SENTENCE: Record<string, string> = {
  'journal.added': 'Runs the moment you add a journal entry.',
  'whatsapp.reply': 'Runs the moment a contact replies on WhatsApp.',
  'bookmark.added': 'Runs the moment a new bookmark lands.',
};
const EVENT_TEXT: Record<string, string> = {
  'journal.added': 'When I add a journal entry',
  'whatsapp.reply': 'When a contact replies on WhatsApp',
  'bookmark.added': 'When a new bookmark lands',
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** "Sunday" · "Monday" — the weekly day. No `dow` stored = Monday, because that is what the scheduler fires on (`s.dow ?? 1`, agent-scheduler.service.ts); the picker itself always stores one. */
export const dayName = (dow?: number) => DAYS[Number.isInteger(dow) && dow! >= 0 && dow! <= 6 ? dow! : 1];

export function schedSentence(s: Sched): string {
  if (!s) return 'Runs only when you press Run.';
  if ('event' in s) return EVENT_SENTENCE[s.event] || 'Runs when that happens.';
  if (s.every === 'day') return `Runs every day at ${s.at || '07:00'}.`;
  if (s.every === 'weekday') return `Runs every weekday at ${s.at || '07:00'}.`;
  if (s.every === 'week') return `Runs every ${dayName(s.dow)} at ${s.at || '08:00'}.`;
  if (s.every === 'hour') return `Runs every hour at :${String(s.minute ?? 0).padStart(2, '0')}.`;
  return 'Runs only when you press Run.';
}

export function schedText(s: Sched): string | null {
  if (!s) return null;
  if ('event' in s) return EVENT_TEXT[s.event] || 'On an event';
  if (s.every === 'day') return `Every day at ${s.at || '07:00'}`;
  if (s.every === 'weekday') return `Every weekday at ${s.at || '07:00'}`;
  if (s.every === 'week') return `Every ${dayName(s.dow)} at ${s.at || '08:00'}`;
  if (s.every === 'hour') return `Every hour at :${String(s.minute ?? 0).padStart(2, '0')}`;
  return null;
}

export function SchedulePicker({ value, onChange }: { value: Sched; onChange: (s: Sched) => void }) {
  const mode = !value ? 'manual' : 'event' in value ? `ev:${value.event}` : value.every;
  const at = (value && !('event' in value) && value.at) || '07:00';
  const set = (e: string, newAt = at) => {
    if (e === 'manual') return onChange(null);
    if (e.startsWith('ev:')) return onChange({ event: e.slice(3) as any });
    if (e === 'hour') return onChange({ every: 'hour', minute: Number(newAt.split(':')[1]) || 0 });
    if (e === 'week') return onChange({ every: 'week', dow: (value && !('event' in value) && value.every === 'week' && Number.isInteger(value.dow)) ? value.dow : 0, at: newAt });
    onChange({ every: e as any, at: newAt });
  };
  const sel = 'rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';
  const timed = value && !('event' in value);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <select value={mode} onChange={(e) => set(e.target.value)} className={sel}>
          <option value="manual">Only when I press Run</option>
          <optgroup label="On a clock">
            <option value="day">Every day</option>
            <option value="weekday">Every weekday</option>
            <option value="week">Every week on…</option>
            <option value="hour">Every hour</option>
          </optgroup>
          <optgroup label="When this happens">
            <option value="ev:journal.added">I add a journal entry</option>
            <option value="ev:whatsapp.reply">A contact replies on WhatsApp</option>
            <option value="ev:bookmark.added">A new bookmark lands</option>
          </optgroup>
        </select>
        {timed && (value as any).every === 'week' && (
          <select value={String((value as any).dow ?? 0)} onChange={(e) => onChange({ every: 'week', dow: Number(e.target.value), at })} className={sel} aria-label="Day of the week">
            {DAYS.map((d, i) => <option key={d} value={String(i)}>{d}</option>)}
          </select>
        )}
        {timed && (value as any).every !== 'hour' && <input type="time" value={at} onChange={(e) => set((value as any).every, e.target.value)} className={sel} />}
        {timed && (value as any).every === 'hour' && (
          <span className="flex items-center gap-1 text-sm text-zinc-500">at minute
            <input type="number" min={0} max={59} value={(value as any).minute ?? 0} onChange={(e) => onChange({ every: 'hour', minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} className={sel + ' w-16'} />
          </span>
        )}
      </div>
      <p className="text-xs text-zinc-400">{schedSentence(value)}</p>
    </div>
  );
}
