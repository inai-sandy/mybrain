import { useState } from 'react';
import { AlertTriangle, Bell, CalendarClock, Check, ChevronDown, Columns3, Database, Loader2, Pencil, Search, X } from 'lucide-react';

/**
 * The plan-with-cost card the thinking builder shows before Create (BEA-1371 → the real thing in
 * BEA-1372), shared by both chat builders (`AgentBuilder`, `NewJobChat`). It draws the plan JSON the
 * server validated — what it fetches (one line per source: action + args × pages; creators-first),
 * what it keeps, where it goes, when, who is told — and ≈ credits + ≈ AI tokens ≈ ₹ per run with a
 * "how" fold showing the server's arithmetic (never a guess). A source whose know-how card says
 * FAILING is marked, kept on purpose. Buttons: Create · Change something · Not now.
 */
export type PlanCost = { credits: number; aiTokens: number; items: number; how: string; aiRupees?: number; unhealthy?: { actionId: string; name: string; note: string }[] };

/** `svc:instagram.search_hashtag` → "Instagram · search hashtag" */
export function shortActionName(id: string): string {
  const bare = String(id || '').replace(/^svc:/, '');
  const dot = bare.indexOf('.');
  const service = dot > 0 ? bare.slice(0, dot) : bare;
  const action = dot > 0 ? bare.slice(dot + 1) : '';
  const cap = (s: string) => s.replace(/[_-]+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());
  return `${cap(service)}${action ? ` · ${action.replace(/[_-]+/g, ' ')}` : ''}`;
}

function argsText(args: Record<string, any> | undefined): string {
  return Object.entries(args || {}).filter(([k, v]) => !String(k).startsWith('_') && v !== '' && v != null).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ');
}

/** One source, in plain words — used by the card and (kept exported) by older tests. */
export function sourceLine(s: any): string {
  if (s?.kind === 'creators') {
    const days = s.then?.keepDays ? `, last ${s.then.keepDays} days` : '';
    const q = argsText(s.find?.args);
    return `Find creators with ${shortActionName(s.find?.actionId)}${q ? ` (${q})` : ''} — the first ${s.find?.take || 10} → each one's ${shortActionName(s.then?.actionId).split(' · ').pop()}${days}`;
  }
  const args = argsText(s?.args);
  return `${shortActionName(s?.actionId)}${args ? ` (${args})` : ''}${(s?.pages || 1) > 1 ? ` × ${s.pages} pages` : ''}`;
}

/** The action ids a source calls — to match it against `cost.unhealthy`. */
function idsOf(s: any): string[] {
  return s?.kind === 'creators' ? [s.find?.actionId, s.then?.actionId].filter(Boolean) : [s?.actionId].filter(Boolean);
}

export function outputText(plan: any): string {
  if (plan?.output?.kind === 'sheet') return plan.output?.sheetId ? 'appends to your Google Sheet' : plan.output?.append ? 'one Google Sheet, kept adding to (made on the first run; rows already there are skipped)' : 'a new Google Sheet each run';
  return 'a Document in your library';
}

const fmtK = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

export function costLine(cost: PlanCost): string {
  const credits = `≈ ${Number(cost.credits || 0).toLocaleString('en-US')} credit${cost.credits === 1 ? '' : 's'}`;
  if (!(cost.aiTokens > 0)) return `${credits} per run · no AI cost`;
  const rupees = typeof cost.aiRupees === 'number' ? ` ≈ ₹${cost.aiRupees}` : '';
  return `${credits} · ≈ ${fmtK(cost.aiTokens)} AI tokens${rupees} per run`;
}

function Row({ icon: Icon, label, children, testId }: { icon: any; label: string; children: any; testId: string }) {
  return (
    <div className="flex gap-2" data-testid={testId}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-300" />
      <div className="min-w-0 flex-1 text-xs text-zinc-700 dark:text-zinc-200">
        <span className="font-semibold text-zinc-500 dark:text-zinc-400">{label} </span>
        {children}
      </div>
    </div>
  );
}

export function PlanCard({ plan, cost, creating, onCreate, onChange, onDismiss, createLabel = 'Create this agent' }: {
  plan: any; cost?: PlanCost | null; creating?: boolean; onCreate: () => void; onChange?: () => void; onDismiss?: () => void; createLabel?: string;
}) {
  const [showHow, setShowHow] = useState(false);
  if (!plan) return null;
  const unhealthy = new Map((cost?.unhealthy || []).map((u) => [u.actionId, u]));
  const mode = plan.mode === 'watch' ? 'Watch — only what is new or changed since last time' : plan.mode === 'alert' ? `Alert — tells you when the condition is met${plan.watch?.condition ? `: “${plan.watch.condition}”` : ''}` : '';
  const keeps = plan.shape?.prompt ? String(plan.shape.prompt) : 'rows as fetched — no AI step';
  const who = [plan.notify?.whatsapp ? 'WhatsApp' : '', plan.notify?.telegram || plan.mode === 'alert' ? 'Telegram' : ''].filter(Boolean).join(' + ');
  const sources: any[] = plan.sources || [];
  return (
    <div data-testid="builder-plan" className="rounded-xl border border-emerald-300 bg-emerald-50/60 p-3 dark:border-emerald-500/30 dark:bg-emerald-500/10">
      <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">The plan</p>
      <div className="mt-1 break-words text-sm font-semibold">{plan.name}</div>

      <div className="mt-2 space-y-1.5">
        <Row icon={Search} label="Fetches" testId="plan-fetch">
          {sources.length === 0 ? <span>nothing yet</span> : (
            <ul className="space-y-0.5">
              {sources.map((s, i) => {
                const bad = idsOf(s).map((id) => unhealthy.get(id)).find(Boolean);
                return (
                  <li key={s.id || i} className="break-words">
                    • {sourceLine(s)}
                    {bad && (
                      <span className="mt-0.5 flex items-start gap-1 text-[11px] text-amber-700 dark:text-amber-300" data-testid="plan-source-unhealthy" title={bad.note}>
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                        <span>{bad.name} is down at the vendor right now — kept so it fills in later.</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Row>
        <Row icon={Columns3} label="Keeps" testId="plan-keep">
          <span className="break-words">{mode ? `${mode} · ` : ''}{keeps}</span>
        </Row>
        <Row icon={Database} label="Goes to" testId="plan-output"><span>{outputText(plan)}</span></Row>
        <Row icon={CalendarClock} label="When" testId="plan-when"><span>{plan.schedule?.text || 'only when you press Run'}</span></Row>
        <Row icon={Bell} label="Tells" testId="plan-notify"><span>{who ? `you on ${who}` : 'no one — you open the result yourself'}</span></Row>
      </div>

      {cost && (
        <div className="mt-2 rounded-lg bg-white/70 px-2.5 py-1.5 dark:bg-zinc-900/40">
          <button type="button" onClick={() => setShowHow((v) => !v)} className="flex w-full items-center gap-1 text-left text-xs font-medium text-emerald-700 dark:text-emerald-300" data-testid="builder-plan-cost" aria-expanded={showHow}>
            <span className="min-w-0 flex-1 break-words">{costLine(cost)}</span>
            <span className="shrink-0 text-[11px] font-normal text-zinc-500">how</span>
            <ChevronDown className={'h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ' + (showHow ? 'rotate-180' : '')} />
          </button>
          {showHow && <p className="mt-1 break-words text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300" data-testid="builder-plan-how">{cost.how}</p>}
        </div>
      )}

      <div className="mt-2.5 flex flex-col gap-1.5 sm:flex-row">
        <button onClick={onCreate} disabled={!!creating} className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50" data-testid="plan-create">
          {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}{createLabel}
        </button>
        {onChange && (
          <button onClick={onChange} disabled={!!creating} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500/40 dark:text-emerald-200 dark:hover:bg-emerald-500/10" data-testid="plan-change">
            <Pencil className="h-3.5 w-3.5" />Change something
          </button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} disabled={!!creating} className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800" data-testid="plan-dismiss">
            <X className="h-3.5 w-3.5" />Not now
          </button>
        )}
      </div>
    </div>
  );
}
