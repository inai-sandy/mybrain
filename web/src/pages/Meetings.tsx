import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mic, Square, Pause, Play, Search, X, Trash2, Clock, FileText, Circle } from 'lucide-react';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useToast } from '../ui/Toast';

type Meeting = {
  id: string;
  title: string;
  durationSec: number;
  status: string;
  hasAudio: boolean;
  summary: string | null;
  createdAt: string;
};

function fmtDur(sec: number) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(ss).padStart(2, '0');
}

export function Meetings() {
  const [list, setList] = useState<Meeting[] | null>(null);
  const [q, setQ] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [delFor, setDelFor] = useState<Meeting | null>(null);
  const navigate = useNavigate();
  const toast = useToast();

  function load() {
    fetch('/api/meetings')
      .then((r) => (r.ok ? r.json() : { meetings: [] }))
      .then((d) => setList(d.meetings || []))
      .catch(() => setList([]));
  }
  useEffect(() => {
    load();
  }, []);

  const filtered = (list || []).filter((m) => !q.trim() || [m.title, m.summary].filter(Boolean).join(' ').toLowerCase().includes(q.toLowerCase()));

  async function remove(m: Meeting) {
    const r = await fetch(`/api/meetings/${m.id}`, { method: 'DELETE' });
    if (r.ok) {
      toast('success', 'Meeting deleted');
      load();
    }
    setDelFor(null);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold flex items-center gap-2"><Mic className="text-emerald-500" /> Meetings</h1>
          <p className="text-zinc-500 text-sm">{list ? `${list.length} recorded` : 'Loading…'} · record now, transcribe only what you need</p>
        </div>
        <button onClick={() => setShowSearch((v) => !v)} aria-label="Search" className={'p-2 rounded-lg border ' + (showSearch || q ? 'border-emerald-500 text-emerald-600' : 'border-zinc-200 dark:border-zinc-800 text-zinc-500')}>
          <Search size={16} />
        </button>
      </div>

      <Recorder onCreated={(id) => navigate(`/meeting/${id}`)} />

      {showSearch && (
        <div className="relative">
          <Search size={15} className="absolute left-2.5 top-2.5 text-zinc-400" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search meetings…" className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-950 border border-zinc-300 dark:border-zinc-700 pl-8 pr-3 py-2 text-sm outline-none focus:border-emerald-500" />
        </div>
      )}

      {list === null ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : filtered.length ? (
        <div className="space-y-2.5">
          {filtered.map((m) => (
            <div key={m.id} className="group flex items-start gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5 hover:border-emerald-500/40 transition-all">
              <button onClick={() => navigate(`/meeting/${m.id}`)} className="min-w-0 flex-1 text-left">
                <div className="font-semibold leading-snug line-clamp-1">{m.title}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                  <span>{new Date(m.createdAt).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  {m.durationSec > 0 && <span className="inline-flex items-center gap-1"><Clock size={11} /> {fmtDur(m.durationSec)}</span>}
                  <span className={'inline-flex items-center gap-1 rounded-full px-2 py-0.5 ' + (m.status === 'transcribed' ? 'bg-emerald-500/10 text-emerald-600' : m.status === 'transcribing' ? 'bg-amber-500/10 text-amber-600' : 'bg-zinc-500/10 text-zinc-500')}>
                    {m.status === 'transcribed' ? <FileText size={10} /> : <Circle size={9} />} {m.status === 'transcribed' ? 'Transcribed' : m.status === 'transcribing' ? 'Transcribing…' : 'Recorded'}
                  </span>
                </div>
                {m.summary && <p className="mt-1.5 text-sm text-zinc-500 dark:text-zinc-400 line-clamp-2">{m.summary}</p>}
              </button>
              <button onClick={() => setDelFor(m)} title="Delete" className="shrink-0 p-1.5 rounded-md text-zinc-400 hover:text-rose-600 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-200 dark:border-zinc-800 p-10 text-center text-sm text-zinc-400">
          {q ? 'No meetings match.' : 'No meetings yet — tap “New meeting” to start recording.'}
        </div>
      )}

      {delFor && <ConfirmDialog title="Delete meeting?" message={`“${delFor.title}” and its recording will be removed.`} confirmLabel="Delete" onConfirm={() => remove(delFor)} onCancel={() => setDelFor(null)} />}
    </div>
  );
}

// ---- the recorder: captures mic audio only (no transcription); top bar with timer + pause/stop ----
function Recorder({ onCreated }: { onCreated: (id: string) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'paused' | 'saving'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const toast = useToast();

  function stopTick() {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }
  function startTick() {
    stopTick();
    tickRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => upload(rec.mimeType || 'audio/webm');
      rec.start(2000); // collect in 2s slices so long meetings don't buffer one giant chunk
      recRef.current = rec;
      setElapsed(0);
      setState('recording');
      startTick();
    } catch {
      toast('error', 'Could not access the microphone. Check browser permissions.');
    }
  }

  function pause() {
    recRef.current?.pause();
    stopTick();
    setState('paused');
  }
  function resume() {
    recRef.current?.resume();
    startTick();
    setState('recording');
  }
  function stop() {
    stopTick();
    setState('saving');
    recRef.current?.stop(); // triggers onstop → upload
  }
  function cleanupStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function upload(mime: string) {
    const blob = new Blob(chunksRef.current, { type: mime });
    cleanupStream();
    try {
      const fd = new FormData();
      const ext = mime.includes('webm') ? 'webm' : 'audio';
      fd.append('audio', blob, `meeting.${ext}`);
      fd.append('title', `Meeting · ${new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
      fd.append('durationSec', String(elapsed));
      const r = await fetch('/api/meetings', { method: 'POST', body: fd });
      if (!r.ok) throw new Error();
      const m = await r.json();
      toast('success', 'Meeting saved');
      setState('idle');
      onCreated(m.id);
    } catch {
      toast('error', 'Could not save the recording');
      setState('idle');
    }
  }

  useEffect(() => () => { stopTick(); cleanupStream(); }, []);

  if (state === 'idle') {
    return (
      <button onClick={start} className="w-full flex items-center justify-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/10 p-3.5 text-sm font-semibold text-emerald-700 dark:text-emerald-300 transition-colors">
        <Mic size={17} /> New meeting — start recording
      </button>
    );
  }

  // Recording bar pinned to the very top of the screen (the app can't draw on the macOS menu bar).
  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-zinc-900 text-white shadow-lg" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="max-w-3xl mx-auto px-4 h-14 flex items-center gap-3">
        <span className={'inline-flex items-center gap-2 ' + (state === 'recording' ? 'text-rose-400' : 'text-amber-300')}>
          <span className={'h-2.5 w-2.5 rounded-full ' + (state === 'recording' ? 'bg-rose-500 animate-pulse' : 'bg-amber-400')} />
          <span className="text-sm font-medium">{state === 'saving' ? 'Saving…' : state === 'paused' ? 'Paused' : 'Recording'}</span>
        </span>
        <span className="font-mono text-lg tabular-nums">{fmtDur(elapsed)}</span>
        <div className="ml-auto flex items-center gap-2">
          {state === 'recording' && (
            <button onClick={pause} className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5 text-sm"><Pause size={15} /> Pause</button>
          )}
          {state === 'paused' && (
            <button onClick={resume} className="inline-flex items-center gap-1.5 rounded-lg bg-white/10 hover:bg-white/20 px-3 py-1.5 text-sm"><Play size={15} /> Resume</button>
          )}
          <button onClick={stop} disabled={state === 'saving'} className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 px-3 py-1.5 text-sm font-medium disabled:opacity-50"><Square size={14} /> Stop</button>
        </div>
      </div>
    </div>
  );
}
