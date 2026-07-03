import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Loader2, CheckCircle2, Circle, AlertCircle, MinusCircle, FileText, HelpCircle, Send, Terminal as TerminalIcon, Copy, Check, RotateCw } from 'lucide-react';

const KIND_RANK: Record<string, number> = { question: 0, subquestion: 1, text: 1, skill: 2, tool: 2, ask_ai: 2, ask_user: 3, if: 3, filter: 3, wait: 3, note: 3, merge: 8, output: 9 };

function NodeStatus({ s }: { s: string }) {
  if (s === 'done') return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (s === 'running') return <Loader2 className="h-4 w-4 animate-spin text-blue-500" />;
  if (s === 'failed') return <AlertCircle className="h-4 w-4 text-rose-500" />;
  if (s === 'skipped') return <MinusCircle className="h-4 w-4 text-zinc-400" />;
  return <Circle className="h-4 w-4 text-zinc-300 dark:text-zinc-600" />;
}

export function FlowRunView() {
  const { id } = useParams();
  const nav = useNavigate();
  const [run, setRun] = useState<any>(null);
  const [ans, setAns] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copyOut(text: string) { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { /* */ } }
  async function reRun(flowId?: string) {
    if (!flowId || rerunning) return;
    setRerunning(true);
    try { const d = await fetch(`/api/flows/${flowId}/run`, { method: 'POST' }).then((r) => r.json()); if (d.runId) nav(`/flows/runs/${d.runId}`); } catch { /* */ }
    setRerunning(false);
  }

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await fetch(`/api/flows/runs/${id}`).then((x) => x.json()).catch(() => null);
      if (!alive) return;
      if (r) setRun(r);
      if (!r || r.status === 'running' || r.status === 'waiting') timer.current = setTimeout(tick, 2500);
    };
    tick();
    return () => { alive = false; if (timer.current) clearTimeout(timer.current); };
  }, [id]);

  async function submitAnswer(value: string) {
    if (!value.trim() || submitting) return;
    setSubmitting(true);
    try {
      await fetch(`/api/flows/runs/${id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer: value }) });
      setAns('');
      setRun((r: any) => ({ ...r, status: 'running', waitQuestion: null })); // optimistic; the poll loop will refresh
    } catch { /* ignore — poll keeps state truthful */ }
    setSubmitting(false);
  }

  if (!run) return <div className="mx-auto max-w-2xl"><div className="h-40 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" /></div>;
  const results = run.results || {};
  const items = Object.entries(results).map(([nid, r]: any) => ({ nid, ...r })).sort((a, b) => (KIND_RANK[a.kind] ?? 5) - (KIND_RANK[b.kind] ?? 5));
  // The original question, shown as the page title. (BEA-773)
  const question = (results.question?.output || run.title || 'Research').toString().trim();
  const focusOf = (out?: string) => (/THIS BRANCH FOCUSES ON:\s*([^\n]+)/.exec(out || '')?.[1] || out || '').trim();
  // Group the run's nodes by branch (b{i}_*) so each sub-question reads as its own section. (BEA-773)
  const branchMap: Record<string, { idx: number; focus: string; nodes: any[] }> = {};
  const loose: any[] = [];
  for (const it of items) {
    if (it.kind === 'output' || it.kind === 'note' || it.kind === 'question' || it.kind === 'merge') continue;
    const m = /^b(\d+)_/.exec(it.nid);
    if (!m) { loose.push(it); continue; }
    const bi = m[1];
    branchMap[bi] = branchMap[bi] || { idx: Number(bi), focus: '', nodes: [] };
    if (it.kind === 'subquestion') branchMap[bi].focus = focusOf(it.output);
    else branchMap[bi].nodes.push(it);
  }
  const branches = Object.values(branchMap).sort((a, b) => a.idx - b.idx);
  const statusPill = 'rounded-full px-2 py-0.5 text-xs font-medium ' + (run.status === 'done' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : run.status === 'failed' ? 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' : 'bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300');

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <button onClick={() => nav(-1)} className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"><ArrowLeft className="h-4 w-4" />Back</button>
      <header className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className={statusPill}>{run.status === 'running' ? 'researching…' : run.status === 'done' ? 'done' : run.status}</span>
          {branches.length > 0 && <span className="text-xs text-zinc-400">{branches.length} sub-question{branches.length === 1 ? '' : 's'}</span>}
        </div>
        <h1 className="text-xl font-bold leading-snug">{question}</h1>
      </header>

      {run.status === 'waiting' && run.waitQuestion && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400"><HelpCircle className="h-4 w-4" />Waiting for you</div>
          <div className="mb-3 whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">{run.waitQuestion}</div>
          {run.waitKind === 'choice' && (run.waitOptions || []).length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {(run.waitOptions || []).map((o: any, i: number) => {
                const label = typeof o === 'string' ? o : o?.label || o?.value || String(o);
                return <button key={i} disabled={submitting} onClick={() => submitAnswer(label)} className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-500/40 dark:bg-zinc-900 dark:text-amber-300">{label}</button>;
              })}
            </div>
          ) : (
            <div className="flex gap-2">
              <textarea value={ans} onChange={(e) => setAns(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAnswer(ans); }} rows={2} placeholder="Type your answer…" className="min-w-0 flex-1 resize-y rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-400 dark:border-zinc-700 dark:bg-zinc-900" />
              <button disabled={submitting || !ans.trim()} onClick={() => submitAnswer(ans)} className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50">{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}Send</button>
            </div>
          )}
        </div>
      )}

      {/* The answer — the hero of the page (BEA-773) */}
      {run.status === 'done' && run.finalOutput && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-500/30 dark:bg-emerald-500/10">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">Answer</span>
            <div className="flex items-center gap-1.5">
              <button onClick={() => copyOut(run.finalOutput)} className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/60 bg-white/70 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-white dark:border-emerald-500/30 dark:bg-zinc-900/60 dark:text-emerald-300">{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}{copied ? 'Copied' : 'Copy'}</button>
              {run.flowId && <button onClick={() => reRun(run.flowId)} disabled={rerunning} className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/60 bg-white/70 px-2 py-1 text-xs font-medium text-emerald-800 hover:bg-white disabled:opacity-50 dark:border-emerald-500/30 dark:bg-zinc-900/60 dark:text-emerald-300">{rerunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCw className="h-3.5 w-3.5" />}Re-run</button>}
            </div>
          </div>
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-800 dark:text-zinc-100">{run.finalOutput}</div>
        </div>
      )}

      {/* Research — one clear section per sub-question (BEA-773) */}
      {(branches.length > 0 || loose.length > 0) && (
        <div className="space-y-2">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-400">{branches.length > 0 ? 'How it researched' : 'Steps'}</div>
          {branches.map((b) => {
            const bStatus = b.nodes.some((n) => n.status === 'running') ? 'running' : b.nodes.length && b.nodes.every((n) => n.status === 'done') ? 'done' : b.nodes.some((n) => n.status === 'failed') ? 'failed' : 'pending';
            return (
              <details key={b.idx} className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" open={bStatus === 'running'}>
                <summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
                  <span className="mt-0.5 shrink-0"><NodeStatus s={bStatus} /></span>
                  <span className="min-w-0 flex-1 font-medium">{b.focus || `Sub-question ${b.idx + 1}`}</span>
                </summary>
                <div className="space-y-2.5 border-t border-zinc-100 px-3 py-2.5 dark:border-zinc-800">
                  {b.nodes.map((n) => (
                    <div key={n.nid}>
                      <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-400"><NodeStatus s={n.status} />{n.label || n.kind}</div>
                      {n.output && <div className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{n.output.slice(0, 3000)}</div>}
                    </div>
                  ))}
                </div>
              </details>
            );
          })}
          {loose.map((i) => (
            <details key={i.nid} className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900" open={i.status === 'running'}>
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm [&::-webkit-details-marker]:hidden"><NodeStatus s={i.status} /><span className="min-w-0 flex-1 truncate font-medium">{i.label || i.kind}</span><span className="shrink-0 text-xs text-zinc-400">{i.kind}{i.status === 'skipped' ? ' · skipped' : ''}</span></summary>
              {i.output && <div className="whitespace-pre-wrap border-t border-zinc-100 px-3 py-2 text-xs leading-relaxed text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">{i.output.slice(0, 3000)}</div>}
            </details>
          ))}
        </div>
      )}
      {branches.length === 0 && loose.length === 0 && run.status === 'running' && <div className="flex items-center gap-2 text-sm text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" />Starting…</div>}

      {/* Terminal — the raw engine log, tucked away */}
      {(run.terminal?.length > 0 || run.status === 'running') && (
        <details open={false} className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-zinc-400 [&::-webkit-details-marker]:hidden"><TerminalIcon className="h-3.5 w-3.5" />Terminal{run.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-blue-400" />}<span className="ml-auto text-zinc-600">{(run.terminal || []).length} lines</span></summary>
          <div className="max-h-72 overflow-auto border-t border-zinc-800 px-3 py-2 font-mono text-xs leading-relaxed text-zinc-300">
            {(run.terminal || []).map((l: any, i: number) => <div key={i} className="whitespace-pre-wrap">{l.text}</div>)}
            {run.status === 'running' && <div className="animate-pulse text-zinc-600">▏</div>}
          </div>
        </details>
      )}
      {run.documents?.length > 0 && (
        <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Documents created · {run.documents.length}</div>
          <ul className="space-y-1">
            {run.documents.map((d: any) => (
              <li key={d.id}>
                <Link to={`/documents/${d.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 hover:text-emerald-700 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-emerald-400"><FileText className="h-4 w-4 shrink-0 text-zinc-400" /><span className="truncate">{d.title}</span></Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {run.status === 'done' && !run.finalOutput && <div className="rounded-2xl border border-zinc-200 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">The flow finished — connect a branch to the Output node to get a final result.</div>}
      {run.status === 'failed' && <div className="rounded-2xl border border-rose-300 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10">{run.error || 'The flow failed.'}</div>}
    </div>
  );
}
