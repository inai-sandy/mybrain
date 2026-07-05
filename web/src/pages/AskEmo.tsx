import { useState, useRef, useEffect } from 'react';
import { Mic, Square, X, Loader2, Volume2, RotateCcw } from 'lucide-react';
import { Sheet } from '../ui/Sheet';
import { Markdown } from '../ui/markdown';

/**
 * EMO Ask — the browser prototype of the device's talk-back loop (BEA-889).
 * Record a question OFFLINE (with a live timer + recording icon) → transcribe → answer from the
 * whole brain (/api/explore/ask) → SPEAK it (OpenAI TTS). Never silent: an instant spoken ack fires
 * on stop, and a RANDOM filler ("still with you…") plays if the answer runs long — so it feels smooth
 * and interactive, not laggy. Same OpenAI voice we'll embed on the device.
 */

const ACK = ['Let me check.', 'One second.', 'Okay, looking now.'];
const FILLERS = ['Still with you.', 'Almost there.', 'Just a moment.', 'Yeah, still working on it.', 'Hold on, nearly done.'];

function fmt(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function rand<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }

/** A short, speakable version of the answer — Emo speaks the headline; the full text stays on screen. */
function forSpeech(t: string): string {
  const clean = (t || '').replace(/\[\d+\]/g, '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const m = clean.match(/^.*?[.!?](\s|$)(.*?[.!?](\s|$))?/);
  const short = (m ? m[0] : clean).trim();
  return short.length > 260 ? short.slice(0, 257).replace(/\s\S*$/, '') + '…' : short;
}

type Phase = 'idle' | 'recording' | 'thinking' | 'speaking' | 'done';

export function AskEmo({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const clips = useRef<Map<string, string>>(new Map()); // pre-fetched line -> objectURL
  const cur = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const waiting = useRef(false);

  useEffect(() => {
    [...ACK, ...FILLERS].forEach(prefetch); // warm the ack + fillers so they play instantly
    return () => cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    if (timer.current) clearInterval(timer.current);
    if (cur.current) { cur.current.pause(); cur.current = null; }
    if (recRef.current?.state === 'recording') recRef.current.stop();
  }
  async function prefetch(text: string) {
    if (clips.current.has(text)) return;
    try {
      const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok) clips.current.set(text, URL.createObjectURL(await r.blob()));
    } catch { /* ignore */ }
  }
  function playUrl(url: string): Promise<void> {
    return new Promise((resolve) => {
      if (cur.current) cur.current.pause();
      const a = new Audio(url); cur.current = a;
      a.addEventListener('ended', () => resolve(), { once: true });
      a.addEventListener('error', () => resolve(), { once: true });
      a.play().catch(() => resolve());
    });
  }
  function playClip(text: string): Promise<void> {
    const url = clips.current.get(text);
    return url ? playUrl(url) : Promise.resolve();
  }
  async function speakLive(text: string): Promise<void> {
    try {
      const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok) await playUrl(URL.createObjectURL(await r.blob()));
    } catch { /* ignore */ }
  }
  function waitForCurrent(): Promise<void> {
    return new Promise((resolve) => {
      const a = cur.current;
      if (!a || a.ended || a.paused) return resolve();
      a.addEventListener('ended', () => resolve(), { once: true });
    });
  }

  async function start() {
    cleanup(); setQuestion(''); setAnswer('');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } as any }).catch(() => null);
    if (!stream) return;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const mr = new MediaRecorder(stream, { mimeType: mime });
    chunks.current = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); void onStopped(new Blob(chunks.current, { type: 'audio/webm' })); };
    recRef.current = mr; mr.start();
    setElapsed(0); setPhase('recording');
    timer.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }
  function stop() {
    if (timer.current) clearInterval(timer.current);
    if (recRef.current?.state === 'recording') recRef.current.stop();
  }

  async function onStopped(blob: Blob) {
    setPhase('thinking'); waiting.current = true;
    void playClip(rand(ACK)); // instant spoken acknowledgement
    const f1 = setTimeout(() => { if (waiting.current) void playClip(rand(FILLERS)); }, 2800);
    const f2 = setTimeout(() => { if (waiting.current) void playClip(rand(FILLERS)); }, 6000);
    // transcribe (offline recording → OpenAI + your names)
    const fd = new FormData(); fd.append('audio', blob, 'ask.webm');
    const tr = await fetch('/api/voice/transcribe', { method: 'POST', body: fd }).then((r) => r.json()).catch(() => ({ text: '' }));
    setQuestion(tr.text || '');
    // answer from your whole brain
    const res = await fetch('/api/explore/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: tr.text || '' }) }).then((r) => r.json()).catch(() => ({ answer: '' }));
    clearTimeout(f1); clearTimeout(f2); waiting.current = false;
    const ans = res.answer || "I couldn't find anything about that in your brain yet.";
    setAnswer(ans); setPhase('speaking');
    await waitForCurrent(); // don't cut off a filler mid-word
    await speakLive(forSpeech(ans));
    setPhase('done');
  }

  const recording = phase === 'recording';
  const busy = phase === 'thinking' || phase === 'speaking';

  return (
    <Sheet onClose={onClose}>
      {(close: () => void) => (
        <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 dark:bg-zinc-900 sm:rounded-2xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><Mic size={17} className="text-emerald-500" /> Ask Emo</h2>
            <button onClick={() => { cleanup(); close(); }} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
          </div>

          {/* the mic / status stage */}
          <div className="flex flex-col items-center justify-center py-6">
            {recording ? (
              <>
                <div className="relative flex h-24 w-24 items-center justify-center">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/30" />
                  <span className="relative inline-flex h-24 w-24 items-center justify-center rounded-full bg-rose-600 text-white"><Mic size={34} /></span>
                </div>
                <div className="mt-4 flex items-center gap-2 text-lg font-semibold tabular-nums">
                  <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" /> {fmt(elapsed)}
                </div>
                <p className="mt-1 text-xs text-zinc-400">Recording · offline</p>
                <button onClick={stop} className="mt-5 inline-flex items-center gap-2 rounded-full bg-rose-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-rose-500"><Square size={14} fill="currentColor" /> Stop</button>
              </>
            ) : busy ? (
              <>
                <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                  {phase === 'speaking' ? <Volume2 size={34} className="animate-pulse" /> : <Loader2 size={34} className="animate-spin" />}
                </div>
                <p className="mt-4 text-sm text-zinc-500">{phase === 'speaking' ? 'Emo is answering…' : 'Thinking…'}</p>
              </>
            ) : (
              <>
                <button onClick={start} className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 transition hover:scale-105 hover:bg-emerald-500"><Mic size={34} /></button>
                <p className="mt-4 text-sm text-zinc-500">{phase === 'done' ? 'Ask another question' : 'Tap and ask a question'}</p>
              </>
            )}
          </div>

          {/* the conversation */}
          {question && (
            <div className="mt-2 rounded-xl bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800/60">
              <span className="text-zinc-400">You asked · </span>{question}
            </div>
          )}
          {answer && (
            <div className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
              <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"><Volume2 size={13} /> Emo</div>
              <Markdown className="text-sm text-zinc-700 dark:text-zinc-200">{answer}</Markdown>
              {phase === 'done' && (
                <button onClick={start} className="mt-3 inline-flex items-center gap-1.5 text-xs text-emerald-600 hover:text-emerald-500"><RotateCcw size={12} /> Ask again</button>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
