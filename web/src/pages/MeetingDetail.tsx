import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Mic, Clock, Pencil, Check, FileText, ListChecks, Sparkles, Lightbulb, Loader2, Share2, Brain, Plus } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { ShareDialog } from '../ui/ShareDialog';

type Meeting = {
  id: string;
  title: string;
  agenda: string | null;
  durationSec: number;
  status: string;
  engine: string | null;
  hasAudio: boolean;
  transcript: string | null;
  summary: string | null;
  takeaways: string[];
  decisions: string[];
  actionItems: any[];
  language: string | null;
  savedToMemory: boolean;
  shared: boolean;
  createdAt: string;
};

function fmtDur(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return (h ? `${h}h ` : '') + `${m}m`;
}

export function MeetingDetail() {
  const { id } = useParams();
  const [d, setD] = useState<Meeting | null>(null);
  const [err, setErr] = useState('');
  const [editing, setEditing] = useState(false);
  const [eTitle, setETitle] = useState('');
  const [eAgenda, setEAgenda] = useState('');
  const [engines, setEngines] = useState<{ id: string; name: string; configured: boolean }[]>([]);
  const [engine, setEngine] = useState('deepgram');
  const [transcribing, setTranscribing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [savingMem, setSavingMem] = useState(false);
  const [addedTasks, setAddedTasks] = useState<Record<number, boolean>>({});
  const toast = useToast();

  function load() {
    fetch(`/api/meetings/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setD)
      .catch(() => setErr('Could not load this meeting.'));
  }
  useEffect(() => {
    load();
    fetch('/api/meetings/engines')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          setEngines(d.engines || []);
          setEngine(d.default || 'deepgram');
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function transcribe() {
    setTranscribing(true);
    try {
      const r = await fetch(`/api/meetings/${id}/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine }) });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.message || 'Transcription failed');
      setD(body);
      toast('success', 'Transcribed ✓');
    } catch (e: any) {
      toast('error', e?.message || 'Transcription failed');
    } finally {
      setTranscribing(false);
    }
  }

  function startEdit() {
    if (!d) return;
    setETitle(d.title);
    setEAgenda(d.agenda || '');
    setEditing(true);
  }
  async function saveEdit() {
    const r = await fetch(`/api/meetings/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: eTitle, agenda: eAgenda }) });
    if (r.ok) {
      setD(await r.json());
      setEditing(false);
      toast('success', 'Saved');
    } else toast('error', 'Could not save');
  }

  async function saveMemory() {
    setSavingMem(true);
    try {
      const r = await fetch(`/api/meetings/${id}/save-memory`, { method: 'POST' });
      if (!r.ok) throw new Error();
      setD((p) => (p ? { ...p, savedToMemory: true } : p));
      toast('success', 'Saved to your memory');
    } catch {
      toast('error', 'Could not save to memory');
    } finally {
      setSavingMem(false);
    }
  }

  async function addTask(title: string, i: number) {
    const r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    if (r.ok) {
      setAddedTasks((p) => ({ ...p, [i]: true }));
      toast('success', 'Added to Tasks');
    } else toast('error', 'Could not add to Tasks');
  }

  const transcribed = d?.status === 'transcribed';

  return (
    <div className="space-y-5 max-w-3xl mx-auto">
      <Link to="/meetings" className="inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
        <ArrowLeft size={16} /> Back to meetings
      </Link>

      {err && <p className="text-amber-500">{err}</p>}

      {d && (
        <>
          <header>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400 mb-2">
                  <span className="inline-flex items-center gap-1"><Mic size={12} className="text-emerald-500" /> {new Date(d.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                  {d.durationSec > 0 && <span className="inline-flex items-center gap-1"><Clock size={12} /> {fmtDur(d.durationSec)}</span>}
                  <span className={'rounded-full px-2 py-0.5 ' + (transcribed ? 'bg-emerald-500/10 text-emerald-600' : 'bg-zinc-500/10 text-zinc-500')}>{transcribed ? 'Transcribed' : 'Recorded'}</span>
                </div>
                {editing ? (
                  <input value={eTitle} onChange={(e) => setETitle(e.target.value)} className="w-full text-2xl font-extrabold rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-1.5" />
                ) : (
                  <h1 className="text-2xl font-extrabold tracking-tight">{d.title}</h1>
                )}
              </div>
              {!editing && (
                <button onClick={startEdit} title="Edit" className="shrink-0 p-2 rounded-lg border border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:text-emerald-600 hover:border-emerald-500">
                  <Pencil size={15} />
                </button>
              )}
            </div>
            {editing && (
              <div className="mt-3 space-y-2">
                <textarea value={eAgenda} onChange={(e) => setEAgenda(e.target.value)} rows={3} placeholder="Agenda / context (optional)" className="w-full resize-y rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm" />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditing(false)} className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm">Cancel</button>
                  <button onClick={saveEdit} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-3 py-1.5 text-sm"><Check size={14} /> Save</button>
                </div>
              </div>
            )}
          </header>

          {/* Audio playback */}
          {d.hasAudio && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <audio controls preload="none" className="w-full" src={`/api/meetings/${d.id}/audio`} />
            </div>
          )}

          {/* Actions: share + save to memory (the write-up is what's shared/saved) */}
          {transcribed && (
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setSharing(true)} className={'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm ' + (d.shared ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 hover:border-emerald-500 hover:text-emerald-600')}>
                <Share2 size={15} /> {d.shared ? 'Shared' : 'Share'}
              </button>
              <button onClick={saveMemory} disabled={savingMem || d.savedToMemory} className={'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-60 ' + (d.savedToMemory ? 'border-indigo-500 text-indigo-600' : 'border-zinc-300 dark:border-zinc-700 hover:border-indigo-500 hover:text-indigo-600')}>
                {savingMem ? <Loader2 size={15} className="animate-spin" /> : d.savedToMemory ? <Check size={15} /> : <Brain size={15} />}
                {d.savedToMemory ? 'In your memory' : savingMem ? 'Saving…' : 'Save to my memory'}
              </button>
            </div>
          )}

          {/* Agenda */}
          {d.agenda && !editing && (
            <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
              <h2 className="text-xs uppercase tracking-wide text-zinc-400 mb-1">Agenda</h2>
              <p className="text-sm text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap">{d.agenda}</p>
            </div>
          )}

          {/* Opt-in transcription — only the meetings you choose get transcribed */}
          {!transcribed && (
            <div className="rounded-xl border border-dashed border-indigo-300/50 dark:border-indigo-500/30 bg-indigo-500/5 p-5 text-center">
              <Sparkles size={20} className="mx-auto text-indigo-400 mb-2" />
              <p className="text-sm font-medium">{transcribing ? 'Transcribing…' : 'Not transcribed yet'}</p>
              <p className="text-xs text-zinc-500 mt-1">{transcribing ? 'Transcribing the recording and writing the summary — this can take a bit for long meetings.' : 'Your recording is saved. Transcribe it when you want — pick a cheaper engine for long meetings.'}</p>
              {d.hasAudio ? (
                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <select value={engine} onChange={(e) => setEngine(e.target.value)} disabled={transcribing} className="rounded-lg bg-white dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 px-2.5 py-2 text-sm">
                    {engines.map((e) => (
                      <option key={e.id} value={e.id} disabled={!e.configured}>{e.name}{e.configured ? '' : ' — needs API key'}</option>
                    ))}
                  </select>
                  <button onClick={transcribe} disabled={transcribing} className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white px-4 py-2 text-sm font-medium disabled:opacity-50">
                    {transcribing ? <><Loader2 size={15} className="animate-spin" /> Transcribing…</> : <><FileText size={15} /> Transcribe</>}
                  </button>
                </div>
              ) : (
                <p className="mt-3 text-xs text-amber-600">No recording attached to this meeting.</p>
              )}
              <p className="mt-2 text-[11px] text-zinc-400">Engine &amp; prompt are configurable in Settings. Deepgram is the cheap default; for Telugu/Hindi a self-hosted model is coming next.</p>
            </div>
          )}

          {/* AI sections (populated after transcription) */}
          {transcribed && (
            <>
              {d.summary && <Section icon={<FileText size={15} className="text-emerald-600" />} title="Summary"><p className="text-sm text-zinc-700 dark:text-zinc-200 whitespace-pre-wrap">{d.summary}</p></Section>}
              {d.takeaways?.length > 0 && <Section icon={<Lightbulb size={15} className="text-amber-500" />} title="Key takeaways"><ul className="list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-200 space-y-1">{d.takeaways.map((t, i) => <li key={i}>{t}</li>)}</ul></Section>}
              {d.decisions?.length > 0 && <Section icon={<Check size={15} className="text-emerald-600" />} title="Decisions"><ul className="list-disc pl-5 text-sm text-zinc-700 dark:text-zinc-200 space-y-1">{d.decisions.map((t, i) => <li key={i}>{t}</li>)}</ul></Section>}
              {d.actionItems?.length > 0 && (
                <Section icon={<ListChecks size={15} className="text-violet-500" />} title="Action items">
                  <ul className="space-y-1.5 text-sm text-zinc-700 dark:text-zinc-200">
                    {d.actionItems.map((t, i) => {
                      const title = typeof t === 'string' ? t : t.title;
                      const owner = typeof t === 'string' ? null : t.owner;
                      const added = addedTasks[i];
                      return (
                        <li key={i} className="flex items-start justify-between gap-2">
                          <span className="flex items-start gap-2 min-w-0"><span className="text-violet-400 mt-1">•</span> <span className="break-words">{title}{owner ? <span className="text-zinc-400"> — {owner}</span> : ''}</span></span>
                          <button onClick={() => addTask(title, i)} disabled={added} className={'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] disabled:opacity-60 ' + (added ? 'border-emerald-500 text-emerald-600' : 'border-zinc-300 dark:border-zinc-700 text-zinc-500 hover:border-emerald-500 hover:text-emerald-600')}>
                            {added ? <><Check size={11} /> Added</> : <><Plus size={11} /> Tasks</>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </Section>
              )}
              {d.transcript && (
                <details className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 p-4">
                  <summary className="text-sm font-semibold cursor-pointer">Full transcript</summary>
                  <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-zinc-600 dark:text-zinc-300 font-mono max-h-[28rem] overflow-auto">{d.transcript}</pre>
                </details>
              )}
            </>
          )}
        </>
      )}
      {!d && !err && <p className="text-zinc-400">Loading…</p>}

      {sharing && d && (
        <ShareDialog
          id={d.id}
          title={d.title}
          initialShared={d.shared}
          shareEndpoint={`/api/meetings/${d.id}/share`}
          publicLink={`${location.origin}/meeting-view/${d.id}`}
          onClose={() => setSharing(false)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <h2 className="flex items-center gap-2 font-semibold text-sm mb-2">{icon} {title}</h2>
      {children}
    </div>
  );
}
