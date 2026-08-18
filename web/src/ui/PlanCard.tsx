import { CalendarClock, Check, Loader2 } from 'lucide-react';

/**
 * The plan-with-cost card the thinking builder shows before Create (BEA-1371) — the small version
 * both chat builders share until the full plan screen (⑤) lands. It draws the plan JSON the server
 * validated: sources (× pages / creators), what it keeps, where it goes, when, who is told, and
 * ≈ credits + ≈ AI tokens per run (server arithmetic, never a guess).
 */
export type PlanCost = { credits: number; aiTokens: number; items: number; how: string };

/** `svc:instagram.search_hashtag` → "Instagram · search hashtag" */
export function shortActionName(id: string): string {
  const bare = String(id || '').replace(/^svc:/, '');
  const dot = bare.indexOf('.');
  const service = dot > 0 ? bare.slice(0, dot) : bare;
  const action = dot > 0 ? bare.slice(dot + 1) : '';
  const cap = (s: string) => s.replace(/[_-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
  return `${cap(service)}${action ? ` · ${action.replace(/[_-]+/g, ' ')}` : ''}`;
}

export function sourceLine(s: any): string {
  if (s?.kind === 'creators') {
    const days = s.then?.keepDays ? ` · last ${s.then.keepDays} days` : '';
    return `Find creators with ${shortActionName(s.find?.actionId)} (${s.find?.take || 10}) → ${shortActionName(s.then?.actionId)} each${days}`;
  }
  const args = Object.entries(s?.args || {}).filter(([k, v]) => !String(k).startsWith('_') && v !== '' && v != null).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
  return `${shortActionName(s?.actionId)}${args ? ` (${args})` : ''}${(s?.pages || 1) > 1 ? ` × ${s.pages} pages` : ''}`;
}

export function PlanCard({ plan, cost, creating, onCreate, createLabel = 'Create this agent' }: { plan: any; cost?: PlanCost | null; creating?: boolean; onCreate: () => void; createLabel?: string }) {
  if (!plan) return null;
  const mode = plan.mode === 'watch' ? 'Watch — only what is new or changed' : plan.mode === 'alert' ? 'Alert — tells you when the condition is met' : 'Fetch every run';
  const out = plan.output?.kind === 'sheet' ? (plan.output?.sheetId ? 'appends to your Google Sheet' : 'a new Google Sheet each run') : 'a Document';
  const who = [plan.notify?.whatsapp ? 'WhatsApp' : '', plan.notify?.telegram ? 'Telegram' : ''].filter(Boolean).join(' + ');
  return (
    <div data-testid="builder-plan" className="rounded-xl border border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">The plan</p>
      <div className="mt-1.5 text-sm font-semibold">{plan.name}</div>
      <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-700 dark:text-zinc-200">
        {(plan.sources || []).map((s: any, i: number) => <li key={i} className="break-words">• {sourceLine(s)}</li>)}
      </ul>
      <p className="mt-1.5 text-xs text-zinc-600 dark:text-zinc-300">{mode}{plan.shape ? ` · keeps: ${String(plan.shape.prompt || '').slice(0, 160)}` : ' · rows as fetched'}</p>
      <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-300">Goes to {out}{who ? ` · tells you on ${who}` : ''}</p>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500"><CalendarClock className="h-3 w-3" />{plan.schedule?.text || 'only when you press Run'}</p>
      {cost && (
        <p className="mt-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300" title={cost.how} data-testid="builder-plan-cost">
          ≈ {cost.credits.toLocaleString('en-US')} credits · ≈ {cost.aiTokens.toLocaleString('en-US')} AI tokens per run
        </p>
      )}
      <button onClick={onCreate} disabled={!!creating} className="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
        {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{createLabel}
      </button>
    </div>
  );
}
