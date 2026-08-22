import { useState } from 'react';
import { AlertTriangle, Check, Loader2, Play, Send, Undo2 } from 'lucide-react';

/**
 * The trial run, on screen (BEA-1408, "Brief First") — the second gate.
 *
 * He approved a *description* of an agent once and lost nine hours to it. A description can say
 * anything. This shows the real rows it fetched, the real message it would send, and what it cost,
 * before a single thing is saved or delivered — and Create stays out of reach until it has passed.
 */

export type Trial = {
  id: string;
  status: 'building' | 'running' | 'passed' | 'failed';
  columns: string[];
  rows: any[][];
  rowCount: number;
  message: string;
  credits: number;
  aiTokens: number;
  verdict: string;
  error: string;
};

export type TrialState = { trial: Trial | null; canCreate: boolean; whyNot: string; running: boolean };

const SHOWN = 8;

export function TrialCard({ state, busy, onRun, onCreate, onSendBack, onSendToMe }: {
  state: TrialState;
  busy?: boolean;
  onRun: () => void;
  onCreate: () => void;
  onSendBack: (note: string) => void;
  onSendToMe?: () => void;
}) {
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState('');
  const [allRows, setAllRows] = useState(false);
  const t = state.trial;

  // ---- nothing has been run yet -------------------------------------------------------------------
  if (!t || (t.status !== 'passed' && t.status !== 'failed' && !state.running)) {
    return (
      <section data-testid="trial-empty" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="text-sm font-semibold">See it work before you keep it</h2>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          It runs once, on your real account, and shows you what it actually got and exactly what it would send.
          <strong className="font-medium text-zinc-700 dark:text-zinc-200"> Nothing is saved, and nothing is sent to anyone.</strong>
        </p>
        <button data-testid="trial-run" onClick={onRun} disabled={busy}
          className="mt-3 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
          <Play className="h-4 w-4" />Run it once
        </button>
        {state.whyNot && !state.canCreate && <p className="mt-2 text-xs text-zinc-500">{state.whyNot}</p>}
      </section>
    );
  }

  // ---- it is going --------------------------------------------------------------------------------
  if (state.running || t.status === 'building' || t.status === 'running') {
    return (
      <section data-testid="trial-running" className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <p className="flex items-center gap-2 text-sm font-medium"><Loader2 className="h-4 w-4 animate-spin" />
          {t.status === 'building' ? 'Building it…' : 'Running it…'}
        </p>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          {t.status === 'building'
            ? 'Writing the program from your brief. This takes a couple of minutes.'
            : 'Fetching for real. Nothing is being saved and nothing is being sent.'}
        </p>
      </section>
    );
  }

  // ---- it failed ----------------------------------------------------------------------------------
  if (t.status === 'failed') {
    return (
      <section data-testid="trial-failed" className="rounded-xl border border-rose-300 bg-rose-50/50 p-4 dark:border-rose-500/30 dark:bg-rose-500/10">
        <p className="flex items-center gap-2 text-sm font-semibold text-rose-800 dark:text-rose-300"><AlertTriangle className="h-4 w-4" />That run did not work</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-200">{t.error || 'It stopped without saying why.'}</p>
        <p className="mt-2 text-xs text-zinc-500">Nothing was saved and nothing was sent. Change the brief above, then run it again.</p>
        <button data-testid="trial-rerun" onClick={onRun} disabled={busy}
          className="mt-3 inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
          <Play className="h-4 w-4" />Run it again
        </button>
      </section>
    );
  }

  // ---- it worked — this is the thing he judges ------------------------------------------------------
  const rows = allRows ? t.rows : t.rows.slice(0, SHOWN);
  const more = t.rows.length - rows.length;

  return (
    <section data-testid="trial-result" className="space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300"><Check className="h-4 w-4" />It ran. Nothing was saved and nothing was sent.</p>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
          It got <strong>{t.rowCount.toLocaleString('en-US')}</strong> {t.rowCount === 1 ? 'thing' : 'things'}
          {t.rowCount > t.rows.length ? ` (the first ${t.rows.length} are below)` : ''}, and it cost {t.credits === 0 ? 'nothing' : `${t.credits} credit${t.credits === 1 ? '' : 's'}`}.
        </p>
        {t.verdict && <p data-testid="trial-verdict" className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t.verdict}</p>}
      </div>

      {/* What it really got. A table, scrolling inside itself — never pushing the page sideways. */}
      {t.rows.length > 0 && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What it got</p>
          <div className="mt-1 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
            <table data-testid="trial-rows" className="w-full text-left text-xs">
              <thead className="bg-zinc-50 dark:bg-zinc-800/60">
                <tr>{(t.columns || []).map((c) => <th key={c} className="whitespace-nowrap px-2 py-1.5 font-semibold text-zinc-600 dark:text-zinc-300">{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                    {(r || []).map((cell: any, j: number) => (
                      <td key={j} className="max-w-[16rem] truncate px-2 py-1.5 text-zinc-700 dark:text-zinc-200" title={String(cell ?? '')}>{String(cell ?? '')}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more > 0 && (
            <button data-testid="trial-more" onClick={() => setAllRows(true)} className="mt-1 text-xs text-violet-700 hover:underline dark:text-violet-300">
              Show {more} more
            </button>
          )}
        </div>
      )}

      {/* The message, exactly as it would arrive. NOT sent. */}
      {t.message && (
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What it would send you</p>
          <div className="mt-1 rounded-2xl rounded-tl-sm bg-emerald-50 px-3 py-2 ring-1 ring-inset ring-emerald-600/15 dark:bg-emerald-400/10 dark:ring-emerald-400/25">
            <p data-testid="trial-message" className="whitespace-pre-wrap break-words text-sm leading-snug text-zinc-800 dark:text-zinc-100">{t.message}</p>
          </div>
          {onSendToMe && (
            <button data-testid="trial-send-to-me" onClick={onSendToMe} disabled={busy}
              className="mt-1.5 inline-flex min-h-[32px] items-center gap-1 rounded-md px-1 text-xs text-zinc-500 hover:text-violet-700 disabled:opacity-40 dark:hover:text-violet-300">
              <Send className="h-3.5 w-3.5" />Send this one to my phone
            </button>
          )}
        </div>
      )}

      {/* Keep it, or send it back. */}
      {sendingBack ? (
        <div>
          <textarea
            autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={2}
            placeholder="What was wrong with it?"
            aria-label="What was wrong with it"
            className="w-full resize-y rounded-md border border-zinc-300 bg-white p-2 text-base leading-snug outline-none focus:border-violet-500 sm:text-sm dark:border-zinc-600 dark:bg-zinc-900"
          />
          <div className="mt-1.5 flex gap-2">
            <button data-testid="send-back-save" onClick={() => { const n = note.trim(); setSendingBack(false); setNote(''); if (n) onSendBack(n); }}
              className="inline-flex min-h-[36px] items-center gap-1 rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-700">
              <Undo2 className="h-3.5 w-3.5" />Send it back
            </button>
            <button onClick={() => { setSendingBack(false); setNote(''); }} className="min-h-[36px] rounded-md px-2.5 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button data-testid="trial-create" onClick={onCreate} disabled={busy || !state.canCreate}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50">
            <Check className="h-4 w-4" />This is what I wanted — keep it
          </button>
          <button data-testid="trial-send-back" onClick={() => setSendingBack(true)} disabled={busy}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-lg border border-zinc-300 px-4 text-sm font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800">
            <Undo2 className="h-4 w-4" />Send it back
          </button>
        </div>
      )}
      {!state.canCreate && state.whyNot && <p data-testid="trial-whynot" className="text-xs text-amber-800 dark:text-amber-300">{state.whyNot}</p>}
    </section>
  );
}
