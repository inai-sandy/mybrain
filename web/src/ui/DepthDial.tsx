import { Zap, Search, Layers } from 'lucide-react';

export type Depth = 'quick' | 'standard' | 'deep';

const OPTS: { key: Depth; label: string; hint: string; icon: typeof Zap }[] = [
  { key: 'quick', label: 'Quick', hint: 'fast answer · ~30s', icon: Zap },
  { key: 'standard', label: 'Standard', hint: 'research + sources', icon: Search },
  { key: 'deep', label: 'Deep', hint: 'full plan · a flow', icon: Layers },
];

/**
 * The one run control (BEA-695): pick how deep a run goes. Quick = fast single turn (saves nothing);
 * Standard = research the web + your brain, cited, saved; Deep = a full editable flow. Replaces the
 * old "Quick answer" checkbox and the hidden quick-vs-flow split.
 */
export function DepthDial({ value, onChange, className = '' }: { value: Depth; onChange: (d: Depth) => void; className?: string }) {
  return (
    <div className={'space-y-1 ' + className}>
      <div className="inline-flex rounded-xl border border-zinc-200 bg-zinc-50 p-0.5 dark:border-zinc-700 dark:bg-zinc-800/60">
        {OPTS.map((o) => {
          const active = value === o.key;
          const Icon = o.icon;
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onChange(o.key)}
              className={
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ' +
                (active
                  ? 'bg-white text-emerald-700 shadow-sm dark:bg-zinc-900 dark:text-emerald-400'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')
              }
              aria-pressed={active}
            >
              <Icon className="h-3.5 w-3.5" />
              {o.label}
            </button>
          );
        })}
      </div>
      <p className="text-[11px] text-zinc-400">{OPTS.find((o) => o.key === value)?.hint}</p>
    </div>
  );
}
