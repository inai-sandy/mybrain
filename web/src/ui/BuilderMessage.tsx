import { Search, Sparkles } from 'lucide-react';

/**
 * One line of a builder conversation (BEA-1372) — the two chat builders draw the same three rows:
 *  - the owner's bubble (right, green) and the builder's bubble (left, grey);
 *  - a **sample** row (`kind:'sample'`, the 🔎 line the sampler wrote, BEA-1370): its own muted row
 *    with a search icon — the text exactly as the server wrote it, never a JSON wall;
 *  - a **seed** row (`kind:'seed'`, the Social hand-off's first line): the builder's bubble with a
 *    small "from your Social run" tag, so it reads as where the conversation started.
 */
export type BuilderLine = { who: 'you' | 'ai'; text: string; kind?: 'sample' | 'seed' | string; at?: string };

export function isSampleLine(m: BuilderLine): boolean {
  return m.kind === 'sample' || (m.who === 'ai' && /^🔎\s/.test(String(m.text || '')));
}

export function BuilderMessage({ m }: { m: BuilderLine }) {
  if (isSampleLine(m)) {
    return (
      <div className="flex justify-start" data-testid="builder-sample-row">
        <div className="flex max-w-[92%] items-start gap-2 rounded-xl border border-dashed border-zinc-200 bg-zinc-50/80 px-3 py-1.5 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/40 dark:text-zinc-400">
          <Search className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 break-words">{String(m.text || '').replace(/^🔎\s*/, '')}</span>
        </div>
      </div>
    );
  }
  const you = m.who === 'you';
  return (
    <div className={'flex ' + (you ? 'justify-end' : 'justify-start')} data-testid={m.kind === 'seed' ? 'builder-seed-row' : undefined}>
      <div className={'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-1.5 text-sm ' + (you ? 'bg-emerald-600 text-white' : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200')}>
        {m.kind === 'seed' && <span className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-300"><Sparkles className="h-3 w-3" />from your Social run</span>}
        {m.text}
      </div>
    </div>
  );
}
