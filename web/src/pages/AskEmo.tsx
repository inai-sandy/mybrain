import { useState, useRef, useEffect } from 'react';
import { Mic, Square, X, Loader2, Volume2, ExternalLink } from 'lucide-react';
import { Sheet } from '../ui/Sheet';

/**
 * EMO Ask — interactive voice talk-back (BEA-889/890). One turn per press, but hands-free after:
 * ask → Emo speaks a clarifying question (always ≥1, more only if still broad) → mic auto-opens and
 * silence auto-stops your reply → … → Emo answers from the whole brain, FILES a Search card, and
 * speaks a SHORT summary (never reads the card). Stays open for a follow-up. Instant spoken ack +
 * random fillers keep it from ever going silent. Same OpenAI voice we embed on the device.
 */

const ACK = ['Let me check, Sandy.', 'One second, Sandy.', 'Okay Sandy, looking now.'];
const FILLERS = ['Still with you, Sandy.', 'Almost there.', 'Just a moment.', 'Yeah, still working on it.', 'Hold on Sandy, nearly done.'];

function fmt(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
function rand<T>(a: T[]): T { return a[Math.floor(Math.random() * a.length)]; }

type Phase = 'idle' | 'recording' | 'thinking' | 'speaking' | 'done';
const GOODBYE = /^\s*(bye|goodbye|good bye|thank you|thanks|that'?s all|that is all|that'?s it|stop|nothing|no thanks|ok bye|okay bye|i'?m done|i am done|done)\b/i;
type Turn = { role: 'user' | 'emo'; text: string; cardId?: string };

export function AskEmo({ onClose, onCardCreated }: { onClose: () => void; onCardCreated?: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [convo, setConvo] = useState<Turn[]>([]);
  const [started, setStarted] = useState(false);

  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const history = useRef<Turn[]>([]);
  const clips = useRef<Map<string, string>>(new Map());
  const cur = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const waiting = useRef(false);
  const mounted = useRef(true);
  const ac = useRef<AudioContext | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    [...ACK, ...FILLERS].forEach(prefetch);
    return () => { mounted.current = false; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cleanup() {
    if (timer.current) clearInterval(timer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
    if (cur.current) { cur.current.pause(); cur.current = null; }
    try { if (recRef.current?.state === 'recording') recRef.current.stop(); } catch { /* ignore */ }
    try { ac.current?.close(); } catch { /* ignore */ }
    ac.current = null;
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
  function playClip(text: string): Promise<void> { const u = clips.current.get(text); return u ? playUrl(u) : Promise.resolve(); }
  async function speak(text: string): Promise<void> {
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
  function push(t: Turn) { setConvo((c) => [...c, t]); }

  async function start() {
    if (!mounted.current) return;
    setStarted(true);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } as any }).catch(() => null);
    if (!stream) { setPhase('idle'); return; }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const mr = new MediaRecorder(stream, { mimeType: mime });
    chunks.current = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    mr.onstop = () => { stream.getTracks().forEach((t) => t.stop()); if (raf.current) cancelAnimationFrame(raf.current); void onStopped(new Blob(chunks.current, { type: 'audio/webm' })); };
    recRef.current = mr; mr.start();
    setElapsed(0); setPhase('recording');
    timer.current = setInterval(() => setElapsed((e) => { if (e + 1 >= 30) stop(); return e + 1; }), 1000);
    listenForSilence(stream); // hands-free: auto-stop ~1.8s after you finish talking
  }
  function listenForSilence(stream: MediaStream) {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new AC(); ac.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      let spoke = false; let lastLoud = performance.now();
      const tick = () => {
        if (!recRef.current || recRef.current.state !== 'recording') return;
        an.getByteTimeDomainData(data);
        let sum = 0; for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
        const level = sum / data.length;
        const now = performance.now();
        if (level > 6) { spoke = true; lastLoud = now; }
        if (spoke && now - lastLoud > 1800) { stop(); return; }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    } catch { /* silence detection optional */ }
  }
  function stop() {
    if (timer.current) clearInterval(timer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
    try { if (recRef.current?.state === 'recording') recRef.current.stop(); } catch { /* ignore */ }
  }
  function autoListen() {
    if (!mounted.current) return;
    setPhase('idle');
    setTimeout(() => { if (mounted.current) void start(); }, 350);
  }

  async function onStopped(blob: Blob) {
    if (!mounted.current) return;
    if (!blob.size) { autoListen(); return; }
    setPhase('thinking'); waiting.current = true;
    void playClip(rand(ACK));
    // fillers fire LATE + rarely, so short answers never trigger a "still working on it"
    const f1 = setTimeout(() => { if (waiting.current) void playClip(rand(FILLERS)); }, 4000);
    const f2 = setTimeout(() => { if (waiting.current) void playClip(rand(FILLERS)); }, 9000);
    const done = () => { clearTimeout(f1); clearTimeout(f2); waiting.current = false; };

    const fd = new FormData(); fd.append('audio', blob, 'ask.webm');
    const tr = await fetch('/api/voice/transcribe', { method: 'POST', body: fd }).then((r) => r.json()).catch(() => ({ text: '' }));
    const text = (tr.text || '').trim();
    if (!text) { done(); setPhase('idle'); return; } // heard nothing → stop (don't loop the mic)
    if (GOODBYE.test(text)) { done(); if (cur.current) cur.current.pause(); setPhase('done'); return; } // "bye/thanks" → end cleanly

    const prior = [...history.current];
    push({ role: 'user', text });
    const res = await fetch('/api/emo/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, history: prior }) }).then((r) => r.json()).catch(() => null);
    done();
    if (!mounted.current) return;
    history.current.push({ role: 'user', text });

    if (!res) { setPhase('idle'); return; }
    if (res.mode === 'clarify' && res.question) {
      history.current.push({ role: 'emo', text: res.question });
      push({ role: 'emo', text: res.question });
      setPhase('speaking'); await waitForCurrent(); await speak(res.question);
      autoListen();
    } else {
      const summary = res.summary || "Here's what I found.";
      push({ role: 'emo', text: summary, cardId: res.cardId });
      setPhase('speaking'); await waitForCurrent(); await speak(summary + ' The full card is in your Emo section.');
      onCardCreated?.();
      history.current = [];
      setPhase('done'); // answer delivered → disconnect; do NOT reopen the mic
    }
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
          <div className="flex flex-col items-center justify-center py-5">
            {recording ? (
              <>
                <div className="relative flex h-24 w-24 items-center justify-center">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/30" />
                  <span className="relative inline-flex h-24 w-24 items-center justify-center rounded-full bg-rose-600 text-white"><Mic size={34} /></span>
                </div>
                <div className="mt-4 flex items-center gap-2 text-lg font-semibold tabular-nums"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" /> {fmt(elapsed)}</div>
                <p className="mt-1 text-xs text-zinc-400">Listening · offline · pauses when you stop</p>
                <button onClick={stop} className="mt-4 inline-flex items-center gap-2 rounded-full bg-rose-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-rose-500"><Square size={14} fill="currentColor" /> Stop</button>
              </>
            ) : busy ? (
              <>
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                  {phase === 'speaking' ? <Volume2 size={34} className="animate-pulse" /> : <Loader2 size={34} className="animate-spin" />}
                </div>
                <p className="mt-4 text-sm text-zinc-500">{phase === 'speaking' ? 'Emo is answering…' : 'Thinking…'}</p>
              </>
            ) : (
              <>
                <button onClick={() => void start()} className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 transition hover:scale-105 hover:bg-emerald-500"><Mic size={34} /></button>
                <p className="mt-4 text-sm text-zinc-500">{phase === 'done' ? 'Done — tap to ask another' : started ? 'Go ahead — I’m listening' : 'Tap and ask a question'}</p>
              </>
            )}
          </div>

          {/* the conversation transcript */}
          {convo.length > 0 && (
            <div className="mt-2 space-y-2">
              {convo.map((t, i) => (
                t.role === 'user' ? (
                  <div key={i} className="ml-8 rounded-xl bg-zinc-100 px-3 py-2 text-sm dark:bg-zinc-800/60"><span className="text-zinc-400">You · </span>{t.text}</div>
                ) : (
                  <div key={i} className="mr-8 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                    <div className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400"><Volume2 size={12} /> Emo</div>
                    <p className="text-sm text-zinc-700 dark:text-zinc-200">{t.text}</p>
                    {t.cardId && <a href="/emo" className="mt-1 inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline"><ExternalLink size={11} /> card in your Emo section</a>}
                  </div>
                )
              ))}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
