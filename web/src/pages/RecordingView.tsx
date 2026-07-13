import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Play, Pause, Bookmark, Trash2, Loader2, Sparkles } from 'lucide-react';
import { useToast } from '../ui/Toast';
import { fmtDur } from './Recordings';

// One session (BEA-975): chunk-playlist player + timeline with mark flags + transcribe-on-demand.
// The audio lives as 10-minute chunks; the player walks them as one continuous session.

type Mark = { id: string; atSeconds: number; windowSec: number; kind: string; wallTime: string; status: string; transcript: string | null; cardId: string | null };
type Chunk = { seq: number; seconds: number; startSec: number; bytes: number };
type Rec = { id: string; title: string | null; day: string; status: string; seconds: number; bytes: number; startedAt: string; endedAt: string | null; marks: Mark[]; chunks: Chunk[] };

function hhmmss(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
}
function wallHM(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export default function RecordingView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [rec, setRec] = useState<Rec | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);           // global session seconds
  const [busyRange, setBusyRange] = useState(false);
  const [fromTxt, setFromTxt] = useState('');
  const [toTxt, setToTxt] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const curSeq = useRef(-1);

  const load = () => fetch(`/api/recordings/${id}`).then((r) => (r.ok ? r.json() : null)).then(setRec).catch(() => setRec(null));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [id]);
  // pending marks resolve as transcription finishes — poll gently while any are cooking
  useEffect(() => {
    if (!rec?.marks?.some((m) => m.status === 'pending')) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [rec]);

  const chunkFor = (sec: number): Chunk | undefined => rec?.chunks.find((c) => sec >= c.startSec && sec < c.startSec + c.seconds) || rec?.chunks[rec.chunks.length - 1];

  function playAt(sec: number) {
    const a = audioRef.current;
    const c = chunkFor(sec);
    if (!a || !c || !rec) return;
    if (curSeq.current !== c.seq) {
      curSeq.current = c.seq;
      a.src = `/api/recordings/${rec.id}/chunk/${c.seq}/audio`;
    }
    a.currentTime = Math.max(0, sec - c.startSec);
    a.play().then(() => setPlaying(true)).catch(() => toast('error', 'Could not play that part.'));
  }

  function onTime() {
    const a = audioRef.current;
    if (!a || !rec) return;
    const c = rec.chunks.find((x) => x.seq === curSeq.current);
    if (c) setPos(c.startSec + a.currentTime);
  }
  function onEnded() {
    if (!rec) return;
    const next = rec.chunks.find((c) => c.seq === curSeq.current + 1);
    if (next) playAt(next.startSec);
    else setPlaying(false);
  }

  function parseTime(t: string): number | null {
    const p = t.trim().split(':').map(Number);
    if (p.some((n) => Number.isNaN(n))) return null;
    if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
    if (p.length === 2) return p[0] * 60 + p[1];
    if (p.length === 1) return p[0];
    return null;
  }

  async function transcribeRange() {
    const from = parseTime(fromTxt), to = parseTime(toTxt);
    if (from == null || to == null || to <= from) { toast('error', 'Give a range like 12:30 → 15:00.'); return; }
    setBusyRange(true);
    const r = await fetch(`/api/recordings/${id}/transcribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fromSec: from, toSec: to }) }).catch(() => null);
    setBusyRange(false);
    if (r?.ok) { toast('success', 'Section transcribed'); setFromTxt(''); setToTxt(''); load(); }
    else toast('error', 'Could not transcribe that section.');
  }

  async function promote(markId: string) {
    const r = await fetch(`/api/recordings/marks/${markId}/promote`, { method: 'POST' }).catch(() => null);
    if (r?.ok) { toast('success', 'Saved to your EMO section'); load(); }
    else toast('error', 'Could not save that.');
  }

  async function del() {
    const r = await fetch(`/api/recordings/${id}`, { method: 'DELETE' }).catch(() => null);
    if (r?.ok) { toast('success', 'Recording deleted'); navigate('/recordings'); }
    else toast('error', 'Could not delete.');
  }

  if (rec === null) return <div className="mx-auto max-w-3xl"><div className="h-40 animate-pulse rounded-2xl bg-zinc-100 dark:bg-zinc-800" /></div>;

  const dur = Math.max(1, rec.seconds);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <button onClick={() => navigate(-1)} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><ArrowLeft size={18} /></button>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold">{rec.title || `Recording · ${rec.day}`}</h1>
            <p className="text-xs text-zinc-500">{fmtDur(rec.seconds)} · {(rec.bytes / 1048576).toFixed(1)} MB · {rec.marks.length} marks{rec.status === 'archived' ? ' · audio on the home server' : ''}</p>
          </div>
        </div>
        {confirmDel ? (
          <span className="flex items-center gap-2 text-xs">
            <span className="text-zinc-500">Delete forever?</span>
            <button onClick={del} className="rounded-full bg-rose-600 px-3 py-1 font-medium text-white">Delete</button>
            <button onClick={() => setConfirmDel(false)} className="rounded-full border border-zinc-200 px-3 py-1 dark:border-zinc-700">Keep</button>
          </span>
        ) : (
          <button onClick={() => setConfirmDel(true)} className="rounded-lg p-2 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10"><Trash2 size={16} /></button>
        )}
      </div>

      {/* player + timeline */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <audio ref={audioRef} onTimeUpdate={onTime} onEnded={onEnded} onPause={() => setPlaying(false)} onPlay={() => setPlaying(true)} />
        <div className="flex items-center gap-3">
          <button onClick={() => (playing ? audioRef.current?.pause() : playAt(pos))}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-emerald-600 text-white hover:bg-emerald-500">
            {playing ? <Pause size={18} /> : <Play size={18} className="ml-0.5" />}
          </button>
          <div className="min-w-0 flex-1">
            <div className="relative h-8 cursor-pointer" onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              playAt(Math.floor(((e.clientX - r.left) / r.width) * dur));
            }}>
              <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 rounded-full bg-zinc-100 dark:bg-zinc-800" />
              <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full bg-emerald-500/70" style={{ width: `${(pos / dur) * 100}%` }} />
              {rec.marks.map((m) => (
                <span key={m.id} title={`${hhmmss(m.atSeconds)} · ${wallHM(m.wallTime)}`}
                  className={`absolute top-0 h-full w-[3px] rounded ${m.kind === 'tap' ? 'bg-amber-400' : 'bg-sky-400'}`}
                  style={{ left: `${(m.atSeconds / dur) * 100}%` }} />
              ))}
            </div>
            <div className="flex justify-between text-[11px] tabular-nums text-zinc-400">
              <span>{hhmmss(Math.floor(pos))}</span>
              <span>{hhmmss(rec.seconds)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* transcribe a section on demand */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <Sparkles size={15} className="text-emerald-500" />
        <span className="text-zinc-500">Transcribe</span>
        <input value={fromTxt} onChange={(e) => setFromTxt(e.target.value)} placeholder="12:30" className="w-20 rounded-lg border border-zinc-200 bg-transparent px-2 py-1 text-center text-xs tabular-nums dark:border-zinc-700" />
        <span className="text-zinc-400">→</span>
        <input value={toTxt} onChange={(e) => setToTxt(e.target.value)} placeholder="15:00" className="w-20 rounded-lg border border-zinc-200 bg-transparent px-2 py-1 text-center text-xs tabular-nums dark:border-zinc-700" />
        <button onClick={transcribeRange} disabled={busyRange} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          {busyRange ? <Loader2 size={12} className="animate-spin" /> : null}Go
        </button>
        <span className="text-[11px] text-zinc-400">— only this section is billed</span>
      </div>

      {/* marks */}
      <div className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Marks & transcripts</h2>
        {rec.marks.length === 0 && <div className="rounded-xl border border-dashed border-zinc-200 py-8 text-center text-sm text-zinc-400 dark:border-zinc-700">No marks — tap A on the device during a session, or transcribe a section above.</div>}
        {rec.marks.map((m) => (
          <div key={m.id} className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="flex items-center gap-2 text-[11px] text-zinc-400">
              <Bookmark size={12} className={m.kind === 'tap' ? 'text-amber-400' : 'text-sky-400'} />
              <button onClick={() => playAt(Math.max(0, m.atSeconds - m.windowSec))} className="font-medium tabular-nums text-emerald-600 hover:underline dark:text-emerald-400">
                {hhmmss(Math.max(0, m.atSeconds - m.windowSec))}–{hhmmss(m.atSeconds)}
              </button>
              <span>· spoken at {wallHM(m.wallTime)}</span>
              {m.status === 'pending' && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-600 dark:text-amber-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />Transcribing</span>}
              {m.status === 'failed' && <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 font-semibold text-rose-600 dark:text-rose-300">Failed</span>}
              <span className="flex-1" />
              {m.transcript && !m.cardId && (
                <button onClick={() => promote(m.id)} className="rounded-full border border-emerald-500/40 px-2.5 py-0.5 font-medium text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400">Save as card</button>
              )}
              {m.cardId && <span className="text-emerald-500">✓ in EMO</span>}
            </div>
            {m.transcript && <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{m.transcript}</p>}
          </div>
        ))}
      </div>
    </div>
  );
}
