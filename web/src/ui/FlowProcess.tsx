import { useState } from 'react';
import { Copy, Check, ListOrdered } from 'lucide-react';

/** Give each plain-English step a small coloured "type" tag so the list scans at a glance (BEA-1092).
 *  The step strings come from the API's fixed describeFlow wording, so keyword matching is reliable. */
function stepTag(s: string): { label: string; cls: string } {
  const t = (s || '').toLowerCase();
  if (/second brain|my notes|my saved|my brain/.test(t)) return { label: 'Brain', cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300' };
  if (/gmail|calendar|google drive/.test(t)) return { label: 'Google', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' };
  if (/the web|read the most relevant|open and read|http/.test(t)) return { label: 'Web', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300' };
  if (/\bskill\b/.test(t)) return { label: 'Skill', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' };
  if (/save the result|send the result|telegram|as a document/.test(t)) return { label: 'Save/send', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' };
  if (/ask me|pause and ask/.test(t)) return { label: 'Ask you', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' };
  return { label: 'Think', cls: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' };
}
const LEGEND = [
  { label: 'Brain', cls: 'bg-indigo-500' }, { label: 'Web', cls: 'bg-blue-500' }, { label: 'Google', cls: 'bg-sky-500' },
  { label: 'Skill', cls: 'bg-violet-500' }, { label: 'Save/send', cls: 'bg-emerald-500' }, { label: 'Ask you', cls: 'bg-amber-500' }, { label: 'Think', cls: 'bg-zinc-400' },
];
function Step({ s }: { s: string }) {
  const tag = stepTag(s);
  return (
    <li className="flex items-start gap-2">
      <span className={'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ' + tag.cls}>{tag.label}</span>
      <span className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{s}</span>
    </li>
  );
}

/**
 * "How it runs" — a readable, step-by-step view of how a flow will execute, plus the matching
 * Claude-Code copy-prompt. Both come from the API's single describeFlow source, so they always
 * agree: paste the prompt into Claude Code to run the exact same process (BEA-669).
 */
export function FlowProcess({ process, prompt }: { process: any; prompt: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(prompt || ''); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* noop */ }
  }
  const branches = process?.branches || [];
  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500"><ListOrdered className="h-3.5 w-3.5" />How it runs</div>
        {branches.length === 0 ? (
          <p className="mt-1 text-sm text-zinc-500">No steps yet — generate the flow or add blocks, and the plan will show here.</p>
        ) : (
          <>
            {process?.task && <p className="mt-1 text-xs text-zinc-500">Task: <span className="text-zinc-700 dark:text-zinc-300">{process.task}</span></p>}
            <ol className="mt-2 space-y-1.5">
              {branches.map((b: any, i: number) => (
                <li key={i} className="rounded-lg border border-zinc-100 p-2 dark:border-zinc-800">
                  <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{i + 1}. {b.question || `Part ${i + 1}`}</div>
                  {b.steps?.length > 0 && (
                    <ul className="mt-1.5 space-y-1">
                      {b.steps.map((s: string, j: number) => <Step key={j} s={s} />)}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
            <p className="mt-2 text-xs text-zinc-500">
              {process?.merge === 'raw' ? '→ Then each part is shown one after another, under its own heading.' : '→ Then all parts are combined into one clear answer.'}
              {process?.hasAskUser ? ' It pauses to ask you along the way.' : ''}
            </p>
            {process?.finishing?.length > 0 && (
              <div className="mt-2 rounded-lg border border-violet-200 bg-violet-50/50 p-2 dark:border-violet-500/30 dark:bg-violet-500/5">
                <div className="text-xs font-medium text-violet-700 dark:text-violet-300">Finishing steps (after combining the parts)</div>
                <ul className="mt-1.5 space-y-1">
                  {process.finishing.map((s: string, j: number) => <Step key={j} s={s} />)}
                </ul>
              </div>
            )}
            {/* colour legend so the tags make sense at a glance (BEA-1092) */}
            <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 border-t border-zinc-100 pt-2 dark:border-zinc-800">
              {LEGEND.map((l) => (
                <span key={l.label} className="inline-flex items-center gap-1 text-[11px] text-zinc-500"><span className={'h-2 w-2 rounded-sm ' + l.cls} />{l.label}</span>
              ))}
            </div>
          </>
        )}
      </div>

      {prompt && (
        <details className="rounded-lg border border-zinc-100 dark:border-zinc-800">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-500 [&::-webkit-details-marker]:hidden"><Copy className="h-3.5 w-3.5" />Copy-paste prompt — runs this exact process in Claude Code</summary>
          <div className="border-t border-zinc-100 p-3 dark:border-zinc-800">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-sans text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">{prompt}</pre>
            <button onClick={copy} className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-sm hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-700">{copied ? <><Check className="h-4 w-4 text-emerald-500" />Copied</> : <><Copy className="h-4 w-4" />Copy prompt</>}</button>
          </div>
        </details>
      )}
    </div>
  );
}
