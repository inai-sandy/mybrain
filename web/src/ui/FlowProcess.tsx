import { useState } from 'react';
import { Copy, Check, ListOrdered } from 'lucide-react';

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
                    <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                      {b.steps.map((s: string, j: number) => <li key={j}>{s}</li>)}
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
                <ul className="mt-1 ml-4 list-disc space-y-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
                  {process.finishing.map((s: string, j: number) => <li key={j}>{s}</li>)}
                </ul>
              </div>
            )}
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
