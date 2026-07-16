import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, ExternalLink, Mic, Square, Loader2, Trash2, Volume2, ChevronLeft, ChevronRight } from 'lucide-react';
import { AskEmo } from './AskEmo';
import { useToast } from '../ui/Toast';
import { Markdown } from '../ui/markdown';
import { AnswerWithSources, EmoSource } from '../ui/Sources';
import { Sheet } from '../ui/Sheet';
import { DictateButton } from '../ui/DictateButton';

function fmtElapsed(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

type Link = { kind: string; id: string; label?: string };
type Card = {
  id: string; lane: string; status: string; title?: string | null; summary?: string | null; detail?: string | null;
  links: Link[]; sources?: EmoSource[]; needsQuestion?: string | null; needsOptions: string[]; needsAnswer?: string | null;
  day: string; rawTranscript?: string | null; audioPath?: string | null; error?: string | null; createdAt: string;
};

// Each lane gets a colour (a left bar + tinted icon chip) so the feed is scannable by type. (BEA-940)
type LaneStyle = { icon: string; label: string; bar: string; chip: string };
const LANE: Record<string, LaneStyle> = {
  search: { icon: '🔎', label: 'Search', bar: 'bg-sky-400', chip: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
  story: { icon: '🎙', label: 'Story', bar: 'bg-violet-400', chip: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
  reminder: { icon: '⏰', label: 'Reminder', bar: 'bg-amber-400', chip: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  task: { icon: '✅', label: 'Task', bar: 'bg-emerald-400', chip: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  meeting: { icon: '🎧', label: 'Meeting', bar: 'bg-teal-400', chip: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300' },
  research: { icon: '🧪', label: 'Research', bar: 'bg-indigo-400', chip: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300' },
  note: { icon: '📝', label: 'Note', bar: 'bg-slate-400', chip: 'bg-slate-100 text-slate-600 dark:bg-slate-500/15 dark:text-slate-300' },
};
const LANE_FALLBACK = (k: string): LaneStyle => ({ icon: '•', label: k, bar: 'bg-zinc-400', chip: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300' });
const STATUS: Record<string, { label: string; cls: string }> = {
  done: { label: 'Done', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  cooking: { label: 'Cooking', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  needs_you: { label: 'Needs you', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
};
const ROUTE: Record<string, (id: string) => string> = {
  task: () => '/tasks', reminder: () => '/contacts', flow: (id) => `/flows/${id}`, meeting: () => '/meetings', document: (id) => `/doc/${id}`, agent: (id) => `/agent/runs/${id}`,
};

function istToday() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
function dayLabel(day: string) {
  const t = istToday();
  const y = new Date(new Date(t + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  if (day === t) return 'Today';
  if (day === y) return 'Yesterday';
  return new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
function hhmm(iso: string) { return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function addDays(day: string, n: number): string { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function fullDate(day: string) { return new Date(day + 'T12:00:00Z').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); }

export default function Emo() {
  const navigate = useNavigate();
  const toast = useToast();
  const [day, setDay] = useState<string>(istToday()); // the day being viewed; ‹ › steps it (BEA-968)
  const [cards, setCards] = useState<Card[] | null>(null); // the viewed day's cards
  const [needsYou, setNeedsYou] = useState<Card[]>([]); // global Needs-you, pinned across all days
  const [status, setStatus] = useState<'' | 'needs_you' | 'cooking' | 'done'>('');
  const [lane, setLane] = useState('');
  const [q, setQ] = useState('');
  const [dictated, setDictated] = useState('');
  const [sending, setSending] = useState(false);
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState<Card | null>(null);
  const [recording, setRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function startRec() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timerRef.current) clearInterval(timerRef.current);
        await uploadBlob(new Blob(chunksRef.current, { type: 'audio/webm' }));
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch { toast('error', 'Microphone permission is needed to record.'); }
  }
  function stopRec() { recRef.current?.stop(); setRecording(false); }

  async function mergeStory() {
    const r = await fetch('/api/emo/story/merge', { method: 'POST' }).catch(() => null);
    if (r?.ok) {
      const d = await r.json().catch(() => ({ merged: 0 }));
      if (d.merged > 0) {
        // A morning story merges into the still-open previous day (BEA-981) — say where it went.
        const today = new Date().toLocaleDateString('en-CA');
        const where = (d.days?.length || 0) > 1 ? 'your stories' : d.storyDay && d.storyDay < today ? "yesterday's story" : "today's story";
        toast('success', `${d.merged} moment${d.merged === 1 ? '' : 's'} added to ${where}`); load();
      }
      else toast('success', 'Nothing new to merge');
      navigate('/today');
    } else toast('error', 'Could not merge into the story.');
  }

  async function uploadBlob(blob: Blob) {
    if (!blob.size) return;
    setUploading(true);
    const fd = new FormData();
    fd.append('file', blob, 'recording.webm');
    const r = await fetch('/api/emo/upload', { method: 'POST', body: fd }).catch(() => null);
    setUploading(false);
    if (r?.ok) {
      const d = await r.json().catch(() => ({ cards: [] }));
      const n = d.cards?.length || 0;
      toast('success', n ? `${n} card${n === 1 ? '' : 's'} filed` : 'Saved');
      load();
    } else toast('error', 'Could not process that recording.');
  }

  // Dictation-driven capture (BEA-886): the cleaned, name-accurate text → the router → cards (search/task/…).
  async function submitCapture() {
    const t = dictated.trim();
    if (!t) return;
    setSending(true);
    const r = await fetch('/api/emo/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: t, source: 'emo-dictation' }) }).catch(() => null);
    setSending(false);
    if (r?.ok) {
      const d = await r.json().catch(() => ({ cards: [] }));
      const n = d.cards?.length || 0;
      toast('success', n ? `${n} card${n === 1 ? '' : 's'} filed` : 'Saved');
      setDictated('');
      load();
    } else toast('error', 'Could not process that.');
  }

  // The viewed day's cards + the global Needs-you list (pinned across all days). (BEA-968)
  async function load() {
    const [c, n] = await Promise.all([
      fetch(`/api/emo/cards?day=${day}&take=500`).then((r) => (r.ok ? r.json() : { cards: [] })).catch(() => ({ cards: [] })),
      fetch('/api/emo/cards?status=needs_you&take=100').then((r) => (r.ok ? r.json() : { cards: [] })).catch(() => ({ cards: [] })),
    ]);
    setCards(c.cards || []);
    setNeedsYou(n.cards || []);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [day]);

  // Keep cooking cards fresh — poll while anything on this day (or a pinned card) is still cooking. (BEA-880)
  useEffect(() => {
    const anyCooking = (cards || []).some((c) => c.status === 'cooking') || needsYou.some((c) => c.status === 'cooking');
    if (!anyCooking) return;
    const t = setInterval(() => { load(); }, 6000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [cards, needsYou, day]);

  // Day-scoped counts for the status pills.
  const dayCounts = useMemo(() => {
    const list = cards || [];
    return { needsYou: list.filter((c) => c.status === 'needs_you').length, cooking: list.filter((c) => c.status === 'cooking').length };
  }, [cards]);

  // The deck = this day's cards, filtered by lane/status/search.
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let list = cards || [];
    if (lane) list = list.filter((c) => c.lane === lane);
    if (status) list = list.filter((c) => c.status === status);
    if (term) list = list.filter((c) => [c.summary, c.title, c.rawTranscript, c.detail].some((s) => (s || '').toLowerCase().includes(term)));
    return list;
  }, [cards, q, lane, status]);

  // Pinned "Needs your attention" (global) shows unless you're actively filtering the deck; when it
  // shows, drop those cards from the deck so they don't appear twice. (BEA-968)
  const needsYouIds = useMemo(() => new Set(needsYou.map((c) => c.id)), [needsYou]);
  const showPinned = !status && !q.trim();
  const deck = useMemo(() => (showPinned ? filtered.filter((c) => !needsYouIds.has(c.id)) : filtered), [filtered, showPinned, needsYouIds]);
  const storiesToday = day === istToday() ? (cards || []).filter((c) => c.lane === 'story').length : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">Emo</h1>
          <p className="text-xs text-zinc-400">Everything you captured by voice — one card per moment.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setAsking(true)} className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 px-4 py-2 text-sm font-medium text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400"><Volume2 size={16} />Ask</button>
        {uploading ? (
          <button disabled className="inline-flex items-center gap-2 rounded-full bg-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"><Loader2 size={16} className="animate-spin" />Transcribing…</button>
        ) : recording ? (
          <button onClick={stopRec} className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-rose-500"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" /><Square size={14} fill="currentColor" />Stop · {fmtElapsed(elapsed)}</button>
        ) : (
          <button onClick={startRec} className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-500"><Mic size={16} />Record</button>
        )}
        </div>
      </div>

      {/* dictation box — the primary way in: dictate (names + AI cleanup) → review the text → Go → auto-routed cards */}
      <div className="rounded-2xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start gap-2">
          <textarea
            value={dictated}
            onChange={(e) => setDictated(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitCapture(); }}
            placeholder="Hold the mic and speak — a question to search, or a task / reminder / story / research to file…"
            rows={2}
            className="min-h-[3rem] flex-1 resize-none rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-emerald-500/50 dark:border-zinc-700 dark:bg-zinc-900"
          />
          <DictateButton onText={(t) => setDictated((d) => (d ? d.replace(/\s*$/, '') + ' ' : '') + t.trim())} size={18} className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-300" />
        </div>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-zinc-400">Dictate · review the text · then Go</span>
          <button onClick={submitCapture} disabled={sending || !dictated.trim()} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
            {sending ? <Loader2 size={14} className="animate-spin" /> : null}Go
          </button>
        </div>
      </div>

      {/* Day pager — one day at a time; ‹ = previous day (BEA-968) */}
      <div className="flex items-center justify-center gap-4 py-1">
        <button onClick={() => setDay((d) => addDays(d, -1))} aria-label="Previous day" title="Previous day" className="grid h-9 w-9 place-items-center rounded-lg border border-zinc-200 text-zinc-500 hover:border-emerald-500 hover:text-emerald-600 dark:border-zinc-800"><ChevronLeft size={18} /></button>
        <div className="min-w-[9rem] text-center">
          <div className="text-sm font-semibold">{dayLabel(day)}</div>
          <div className="text-[11px] text-zinc-400">{fullDate(day)}</div>
        </div>
        <button onClick={() => setDay((d) => addDays(d, 1))} disabled={day >= istToday()} aria-label="Next day" title="Next day" className="grid h-9 w-9 place-items-center rounded-lg border border-zinc-200 text-zinc-500 enabled:hover:border-emerald-500 enabled:hover:text-emerald-600 disabled:opacity-30 dark:border-zinc-800"><ChevronRight size={18} /></button>
      </div>

      {/* filters (scoped to the viewed day) */}
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={() => setStatus(status === 'needs_you' ? '' : 'needs_you')} className={`rounded-full px-3 py-1 text-xs font-medium ${status === 'needs_you' ? 'ring-2 ring-rose-400' : ''} ${STATUS.needs_you.cls}`}>⚠ Needs you {dayCounts.needsYou}</button>
        <button onClick={() => setStatus(status === 'cooking' ? '' : 'cooking')} className={`rounded-full px-3 py-1 text-xs font-medium ${status === 'cooking' ? 'ring-2 ring-amber-400' : ''} ${STATUS.cooking.cls}`}>⏳ Cooking {dayCounts.cooking}</button>
        <button onClick={() => setStatus(status === 'done' ? '' : 'done')} className={`rounded-full px-3 py-1 text-xs font-medium ${status === 'done' ? 'ring-2 ring-emerald-400' : ''} ${STATUS.done.cls}`}>✓ Done</button>
        {status && <button onClick={() => setStatus('')} className="rounded-full px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">All</button>}
        <select value={lane} onChange={(e) => setLane(e.target.value)} className="rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-xs dark:border-zinc-700 dark:bg-zinc-900">
          <option value="">All lanes</option>
          {Object.entries(LANE).map(([k, v]) => <option key={k} value={k}>{v.icon} {v.label}</option>)}
        </select>
        <div className="relative ml-auto">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cards" className="w-44 rounded-lg border border-zinc-200 bg-white py-1.5 pl-8 pr-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
        </div>
      </div>

      {/* Pinned "Needs your attention" — global, across ALL days, so an old ask never gets buried. (BEA-968) */}
      {showPinned && needsYou.length > 0 && (
        <div className="space-y-1.5 rounded-2xl border border-rose-200 bg-rose-50/40 p-3 dark:border-rose-500/20 dark:bg-rose-500/[0.04]">
          <h2 className="px-0.5 text-xs font-semibold uppercase tracking-wide text-rose-600 dark:text-rose-300">⚡ Needs your attention</h2>
          {needsYou.map((c) => <CardRow key={c.id} c={c} onOpen={() => setOpen(c)} />)}
        </div>
      )}

      {/* Story-captures merge strip — today only, when 2+ stories are waiting. */}
      {storiesToday >= 2 && (
        <div className="flex items-center justify-between rounded-xl border border-violet-200 bg-violet-50/60 px-3 py-2 dark:border-violet-500/20 dark:bg-violet-500/[0.06]">
          <span className="text-xs font-medium text-violet-600 dark:text-violet-300">🎙 {storiesToday} story captures today</span>
          <button onClick={mergeStory} className="text-xs font-medium text-emerald-600 hover:underline">Merge into Story →</button>
        </div>
      )}

      {/* This day's deck */}
      {cards === null ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-zinc-100 dark:bg-zinc-800" />)}</div>
      ) : deck.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-zinc-200 py-16 text-center text-sm text-zinc-400 dark:border-zinc-700">
          <div className="mb-2 text-2xl">🎙</div>
          {q || status || lane
            ? 'No cards match.'
            : day === istToday()
              ? 'No cards yet today — your voice captures will land here.'
              : `Nothing captured on ${dayLabel(day)}.`}
        </div>
      ) : (
        <div className="space-y-1.5">
          {deck.map((c) => <CardRow key={c.id} c={c} onOpen={() => setOpen(c)} />)}
        </div>
      )}

      {open && <CardDetail card={open} onClose={() => setOpen(null)} onChanged={() => { load(); }} />}
      {asking && <AskEmo onClose={() => setAsking(false)} onCardCreated={() => load()} />}
    </div>
  );
}

function CardRow({ c, onOpen }: { c: Card; onOpen: () => void }) {
  const lane = LANE[c.lane] || LANE_FALLBACK(c.lane);
  const needs = c.status === 'needs_you';
  const cooking = c.status === 'cooking';
  // Done cards look calm (no badge); only Needs-you / Cooking carry a status pill. (BEA-940)
  return (
    <button
      onClick={onOpen}
      className={`flex w-full items-stretch overflow-hidden rounded-xl border text-left transition hover:border-emerald-500/40 ${needs ? 'border-rose-300 bg-rose-50/50 dark:border-rose-500/30 dark:bg-rose-500/5' : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900'}`}
    >
      <span className={`w-1 shrink-0 ${needs ? 'bg-rose-400' : lane.bar}`} aria-hidden />
      <span className="flex min-w-0 flex-1 items-start gap-3 px-3 py-3">
        <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base ${lane.chip}`} title={lane.label}>{lane.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm leading-snug line-clamp-2">{c.summary || c.title || <span className="text-zinc-400">Untitled</span>}</span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
            <span className="font-medium text-zinc-500 dark:text-zinc-400">{lane.label}</span>
            <span>· {hhmm(c.createdAt)}</span>
            {needs && <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 font-semibold text-rose-600 dark:text-rose-300">Needs you</span>}
            {cooking && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 font-semibold text-amber-600 dark:text-amber-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />Cooking</span>}
          </span>
        </span>
      </span>
    </button>
  );
}

function CardDetail({ card, onClose, onChanged }: { card: Card; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const lane = LANE[card.lane] || LANE_FALLBACK(card.lane);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);

  async function del(close: () => void) {
    setBusy(true);
    const r = await fetch(`/api/emo/cards/${card.id}`, { method: 'DELETE' }).catch(() => null);
    setBusy(false);
    if (r?.ok) { toast('success', 'Card deleted'); onChanged(); close(); }
    else toast('error', 'Could not delete that card.');
  }

  async function submitAnswer(close: () => void) {
    if (!answer.trim()) return;
    setBusy(true);
    const r = await fetch(`/api/emo/cards/${card.id}/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) }).catch(() => null);
    setBusy(false);
    if (r?.ok) { toast('success', 'Thanks — Emo will finish this off.'); onChanged(); close(); }
    else toast('error', 'Could not send that.');
  }

  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 dark:bg-zinc-900 sm:rounded-2xl">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-2xl">{lane.icon}</span>
              <div>
                <div className="text-sm font-semibold">{card.summary || card.title || lane.label}</div>
                <div className="text-xs text-zinc-400">{lane.label} · {STATUS[card.status]?.label || card.status} · {hhmm(card.createdAt)}</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={() => setConfirmDel(true)} title="Delete card" className="rounded-lg p-1.5 text-zinc-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"><Trash2 size={17} /></button>
              <button onClick={close} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
            </div>
          </div>

          {confirmDel && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-500/30 dark:bg-rose-500/10">
              <span className="text-sm text-rose-700 dark:text-rose-300">Delete this card permanently?</span>
              <div className="flex shrink-0 gap-2">
                <button onClick={() => setConfirmDel(false)} className="rounded-lg px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancel</button>
                <button onClick={() => del(close)} disabled={busy} className="rounded-lg bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-500 disabled:opacity-50">Delete</button>
              </div>
            </div>
          )}

          {/* Needs-you: the on-card clarify (durable HITL) */}
          {card.status === 'needs_you' && card.needsQuestion && (
            <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 dark:border-rose-500/30 dark:bg-rose-500/10">
              <div className="mb-2 text-sm font-medium text-rose-700 dark:text-rose-300">{card.needsQuestion}</div>
              {card.needsOptions.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {card.needsOptions.map((o) => <button key={o} onClick={() => setAnswer(o)} className={`rounded-full border px-2.5 py-1 text-xs ${answer === o ? 'border-rose-400 bg-rose-100 dark:bg-rose-500/20' : 'border-zinc-200 dark:border-zinc-700'}`}>{o}</button>)}
                </div>
              )}
              <div className="flex gap-2">
                <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type your answer…" className="flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" />
                <button onClick={() => submitAnswer(close)} disabled={busy || !answer.trim()} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">Send</button>
              </div>
            </div>
          )}

          {/* links to the real objects */}
          {card.links.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {card.links.map((l, i) => {
                const to = ROUTE[l.kind]?.(l.id);
                return to ? (
                  <button key={i} onClick={() => { close(); navigate(to); }} className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium hover:border-emerald-500/40 dark:border-zinc-700">
                    <ExternalLink size={13} />{l.label || `Open ${l.kind}`}
                  </button>
                ) : null;
              })}
            </div>
          )}

          {card.detail && (
            card.sources && card.sources.length > 0
              ? <div className="mb-4 rounded-xl bg-zinc-50 p-3 dark:bg-zinc-800/50"><AnswerWithSources answer={card.detail} sources={card.sources} /></div>
              : <Markdown className="mb-4 rounded-xl bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">{card.detail}</Markdown>
          )}

          {card.error && <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">⚠ {card.error}</div>}

          {/* Go deeper — quick research → a saved deep-research flow (BEA-871) */}
          {card.lane === 'research' && card.status === 'done' && !card.links.some((l) => l.kind === 'flow') && (
            <button
              onClick={async () => {
                setBusy(true);
                const r = await fetch(`/api/emo/cards/${card.id}/go-deeper`, { method: 'POST' }).catch(() => null);
                setBusy(false);
                if (r?.ok) { toast('success', 'Deep research flow built and saved.'); onChanged(); close(); }
                else toast('error', 'Could not build the deep flow.');
              }}
              disabled={busy}
              className="mb-4 inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 px-3 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 dark:border-indigo-500/40 dark:text-indigo-300 dark:hover:bg-indigo-500/10"
            >
              🔎 Go deeper — build a research flow
            </button>
          )}

          {card.audioPath && (
            <div className="text-sm">
              <p className="mb-1 text-xs font-medium text-zinc-500">Recording (what EMO heard)</p>
              <audio controls preload="none" className="h-9 w-full" src={`/api/emo/cards/${card.id}/audio`} />
            </div>
          )}

          {card.rawTranscript && card.lane !== 'talk' && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-medium text-zinc-500">What you said (transcript)</summary>
              <p className="mt-2 whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">{card.rawTranscript}</p>
            </details>
          )}

          <div className="pt-2">
            {card.links?.some((l) => l.kind === 'note') ? (
              <span className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-300">✓ Saved to notes</span>
            ) : (
              <button
                onClick={async () => {
                  setBusy(true);
                  const r = await fetch(`/api/emo/cards/${card.id}/save-note`, { method: 'POST' }).catch(() => null);
                  setBusy(false);
                  if (r?.ok) { toast('success', 'Saved to your Notes.'); onChanged(); }
                  else toast('error', 'Could not save the note.');
                }}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                📝 Save to notes
              </button>
            )}
          </div>
        </div>
      )}
    </Sheet>
  );
}
