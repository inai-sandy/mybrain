import { useState, useRef, useEffect } from 'react';
import { Mic, Square, X, Loader2, Volume2, ExternalLink, Hand } from 'lucide-react';
import { Sheet } from '../ui/Sheet';

/**
 * EMO Ask — interactive voice talk-back (BEA-889→893). Persistent mic for the whole session so it can
 * listen while it speaks. On open Emo greets Sandy and starts listening. Flow: ask → clarify (≥1) →
 * answer from the whole brain → files a complete Search card → speaks a SHORT summary → OFFERS a next
 * action if useful ("Want me to remind Srikar?") → done. Extras: remembers the thread across questions
 * (resolves "that"/"the other one"), and BARGE-IN — talk over Emo (or tap) to cut it off and redirect.
 */

// Name lives in the greeting + the LLM's questions/answers (used naturally there). The short clips stay
// name-free so they don't sound stitched, and every pool never repeats its last line (BEA-894).
const GREETING = 'Hey Sandy, what do you need?';
const ACK = ['Okay, let me look.', 'Sure, one sec.', 'On it — checking now.', 'Let me see.', 'Alright, looking now.', 'Give me a moment.'];
const FILLERS = ['Still on it.', 'Almost there.', 'Just a moment.', 'Nearly done now.', 'Bear with me a sec.', 'Hang on, pulling it up.'];
const CLOSINGS = ['The full card’s in your Emo section.', 'I’ve saved it as a card for you.', 'The details are on the card.', 'It’s saved in your Emo section.'];
const DONE_LINES = ['Done — it’s in your Emo section.', 'Sorted, I’ve added that for you.', 'All set — that’s saved.'];
const OKAY_LINES = ['Okay, no problem.', 'Sure, I’ll leave it.', 'Alright then.'];
const GOODBYE = /^\s*(bye|goodbye|good bye|thank you|thanks|that'?s all|that is all|that'?s it|stop|nothing|no thanks|ok bye|okay bye|i'?m done|i am done|done)\b/i;
const YES = /\b(yes|yeah|yep|yup|sure|ok|okay|please|do it|go ahead|of course|definitely)\b/i;

function fmt(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

type Phase = 'boot' | 'idle' | 'recording' | 'thinking' | 'speaking' | 'done';
type Turn = { role: 'user' | 'emo'; text: string; cardId?: string };

export function AskEmo({ onClose, onCardCreated }: { onClose: () => void; onCardCreated?: () => void }) {
  const [phase, setPhase] = useState<Phase>('boot');
  const [elapsed, setElapsed] = useState(0);
  const [convo, setConvo] = useState<Turn[]>([]);

  const stream = useRef<MediaStream | null>(null);
  const ac = useRef<AudioContext | null>(null);
  const analyser = useRef<AnalyserNode | null>(null);
  const buf = useRef<Uint8Array | null>(null);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const history = useRef<Turn[]>([]);              // clarify chain for the CURRENT question
  const sessionMem = useRef<{ q: string; a: string }[]>([]); // thread memory across questions
  const pendingOffer = useRef<string | null>(null); // an action awaiting yes/no
  const clips = useRef<Map<string, string>>(new Map());
  const cur = useRef<HTMLAudioElement | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const raf = useRef<number | null>(null);
  const waiting = useRef(false);
  const mounted = useRef(true);
  const phaseRef = useRef<Phase>('boot');
  function setPh(p: Phase) { phaseRef.current = p; setPhase(p); }
  const lastPick = useRef<Record<string, string>>({});
  /** Pick a line from a pool, never the same one twice in a row. */
  function pick(pool: string[], key: string): string {
    const opts = pool.length > 1 ? pool.filter((x) => x !== lastPick.current[key]) : pool;
    const c = opts[Math.floor(Math.random() * opts.length)];
    lastPick.current[key] = c;
    return c;
  }

  useEffect(() => {
    mounted.current = true;
    void init();
    return () => { mounted.current = false; teardown(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function teardown() {
    if (timer.current) clearInterval(timer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
    if (cur.current) { cur.current.pause(); cur.current = null; }
    try { if (recRef.current?.state === 'recording') recRef.current.stop(); } catch { /* ignore */ }
    stream.current?.getTracks().forEach((t) => t.stop());
    try { ac.current?.close(); } catch { /* ignore */ }
  }

  async function init() {
    await Promise.all([GREETING, ...ACK, ...FILLERS].map(prefetch));
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as any }).catch(() => null);
    if (!mounted.current) { s?.getTracks().forEach((t) => t.stop()); return; }
    if (s) {
      stream.current = s;
      try {
        const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
        const ctx = new AC(); ac.current = ctx;
        const src = ctx.createMediaStreamSource(s);
        const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
        analyser.current = an; buf.current = new Uint8Array(an.frequencyBinCount);
      } catch { /* analyser optional */ }
    }
    await playUrl(clips.current.get(GREETING)); // greet by name
    if (mounted.current) startRec();
  }

  async function prefetch(text: string) {
    if (clips.current.has(text)) return;
    try {
      const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok) clips.current.set(text, URL.createObjectURL(await r.blob()));
    } catch { /* ignore */ }
  }
  function level(): number {
    const an = analyser.current, d = buf.current;
    if (!an || !d) return 0;
    an.getByteTimeDomainData(d as any);
    let sum = 0; for (let i = 0; i < d.length; i++) sum += Math.abs(d[i] - 128);
    return sum / d.length;
  }

  /** Play audio while watching for the user talking OVER it → resolves 'barge' so we stop and listen. */
  function playUrl(url?: string): Promise<'ended' | 'barge'> {
    return new Promise((resolve) => {
      if (!url) return resolve('ended');
      if (cur.current) cur.current.pause();
      const a = new Audio(url); cur.current = a;
      let settled = false;
      const finish = (how: 'ended' | 'barge') => { if (settled) return; settled = true; if (raf.current) cancelAnimationFrame(raf.current); resolve(how); };
      a.addEventListener('ended', () => finish('ended'), { once: true });
      a.addEventListener('error', () => finish('ended'), { once: true });
      a.play().catch(() => finish('ended'));
      if (analyser.current) {
        let loud = 0; let last = performance.now();
        const watch = () => {
          if (settled) return;
          const now = performance.now(); const dt = now - last; last = now;
          if (level() > 16) loud += dt; else loud = Math.max(0, loud - dt * 1.5);
          if (loud > 400) { a.pause(); finish('barge'); return; } // sustained loud = talking over Emo
          raf.current = requestAnimationFrame(watch);
        };
        raf.current = requestAnimationFrame(watch);
      }
    });
  }
  function playClip(text: string) { return playUrl(clips.current.get(text)); }
  async function speak(text: string): Promise<'ended' | 'barge'> {
    try {
      const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok) return await playUrl(URL.createObjectURL(await r.blob()));
    } catch { /* ignore */ }
    return 'ended';
  }
  function push(t: Turn) { setConvo((c) => [...c, t]); }
  function sessionContext(): string { return sessionMem.current.slice(-4).map((m) => `Q: ${m.q} → ${m.a}`).join('\n'); }

  function startRec() {
    const s = stream.current;
    if (!s || !mounted.current) { setPh('idle'); return; }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const mr = new MediaRecorder(s, { mimeType: mime });
    chunks.current = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
    mr.onstop = () => { if (raf.current) cancelAnimationFrame(raf.current); void onStopped(new Blob(chunks.current, { type: 'audio/webm' })); };
    recRef.current = mr; mr.start();
    setElapsed(0); setPh('recording');
    timer.current = setInterval(() => setElapsed((e) => { if (e + 1 >= 30) stopRec(); return e + 1; }), 1000);
    let spoke = false; let lastLoud = performance.now();
    const tick = () => {
      if (recRef.current?.state !== 'recording') return;
      const l = level(); const now = performance.now();
      if (l > 6) { spoke = true; lastLoud = now; }
      if (spoke && now - lastLoud > 1800) { stopRec(); return; } // hands-free: stop ~1.8s after you finish
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }
  function stopRec() {
    if (timer.current) clearInterval(timer.current);
    if (raf.current) cancelAnimationFrame(raf.current);
    try { if (recRef.current?.state === 'recording') recRef.current.stop(); } catch { /* ignore */ }
  }
  function interrupt() { if (cur.current) cur.current.pause(); if (mounted.current) startRec(); } // tap-to-interrupt

  async function onStopped(blob: Blob) {
    if (!mounted.current) return;
    if (!blob.size) { setPh('idle'); return; }
    setPh('thinking'); waiting.current = true;
    void playClip(pick(ACK, 'ack'));
    const f1 = setTimeout(() => { if (waiting.current) void playClip(pick(FILLERS, 'filler')); }, 4000);
    const f2 = setTimeout(() => { if (waiting.current) void playClip(pick(FILLERS, 'filler')); }, 9000);
    const done = () => { clearTimeout(f1); clearTimeout(f2); waiting.current = false; };

    const fd = new FormData(); fd.append('audio', blob, 'ask.webm');
    const tr = await fetch('/api/voice/transcribe', { method: 'POST', body: fd }).then((r) => r.json()).catch(() => ({ text: '' }));
    const text = (tr.text || '').trim();
    if (!text) { done(); setPh('idle'); return; }
    if (GOODBYE.test(text) && !pendingOffer.current) { done(); if (cur.current) cur.current.pause(); setPh('done'); return; }

    // Answering a "want me to…" action offer?
    if (pendingOffer.current) {
      const action = pendingOffer.current; pendingOffer.current = null;
      push({ role: 'user', text });
      if (YES.test(text)) {
        await fetch('/api/emo/capture', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transcript: action, source: 'emo-ask-action' }) }).catch(() => null);
        onCardCreated?.();
        done(); const dl = pick(DONE_LINES, 'confirm'); push({ role: 'emo', text: dl }); setPh('speaking'); await speak(dl);
      } else { done(); const ol = pick(OKAY_LINES, 'confirm'); push({ role: 'emo', text: ol }); setPh('speaking'); await speak(ol); }
      setPh('done'); return;
    }

    // Normal Ask turn.
    const prior = [...history.current];
    push({ role: 'user', text });
    const res = await fetch('/api/emo/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: text, history: prior, sessionContext: sessionContext() }) }).then((r) => r.json()).catch(() => null);
    done();
    if (!mounted.current) return;
    history.current.push({ role: 'user', text });

    if (!res) { setPh('idle'); return; }
    if (res.mode === 'clarify' && res.question) {
      history.current.push({ role: 'emo', text: res.question });
      push({ role: 'emo', text: res.question });
      setPh('speaking'); const how = await speak(res.question);
      startRec(); void how; // barge or ended → listen for the reply either way
    } else {
      const summary = res.summary || 'Here’s what I found.';
      const baseQ = history.current.find((t) => t.role === 'user')?.text || text;
      sessionMem.current.push({ q: baseQ, a: summary }); // remember the thread
      history.current = [];
      push({ role: 'emo', text: summary, cardId: res.cardId });
      onCardCreated?.();
      // Ask for the follow-up offer WHILE we're speaking the answer, so its round trip costs no
      // waiting (it used to be computed before the response came back at all). (BEA-1012)
      const offerP: Promise<any> = res.cardId
        ? fetch('/api/emo/ask/offer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cardId: res.cardId }) }).then((r) => r.json()).catch(() => ({}))
        : Promise.resolve({});
      setPh('speaking'); await speak(summary + ' ' + pick(CLOSINGS, 'closing'));
      // Offer a next action if there is one.
      const offer = (res.offer || (await offerP)?.offer) as { spoken?: string; action?: string } | undefined;
      if (offer?.spoken && offer?.action) {
        pendingOffer.current = offer.action;
        push({ role: 'emo', text: offer.spoken });
        setPh('speaking'); await speak(offer.spoken);
        startRec(); // listen for yes/no
        return;
      }
      setPh('done'); // no offer → disconnect
    }
  }

  const recording = phase === 'recording';
  const speaking = phase === 'speaking';
  const busy = phase === 'thinking' || phase === 'speaking';
  const boot = phase === 'boot';

  return (
    <Sheet onClose={onClose}>
      {(close: () => void) => (
        <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-white p-5 dark:bg-zinc-900 sm:rounded-2xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-semibold"><Mic size={17} className="text-emerald-500" /> Ask Emo</h2>
            <button onClick={() => { teardown(); close(); }} className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"><X size={18} /></button>
          </div>

          <div className="flex flex-col items-center justify-center py-5">
            {recording ? (
              <>
                <div className="relative flex h-24 w-24 items-center justify-center">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/30" />
                  <span className="relative inline-flex h-24 w-24 items-center justify-center rounded-full bg-rose-600 text-white"><Mic size={34} /></span>
                </div>
                <div className="mt-4 flex items-center gap-2 text-lg font-semibold tabular-nums"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-rose-500" /> {fmt(elapsed)}</div>
                <p className="mt-1 text-xs text-zinc-400">Listening · offline · pauses when you stop</p>
                <button onClick={stopRec} className="mt-4 inline-flex items-center gap-2 rounded-full bg-rose-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-rose-500"><Square size={14} fill="currentColor" /> Stop</button>
              </>
            ) : speaking ? (
              <>
                <button onClick={interrupt} title="Tap to interrupt" className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500"><Volume2 size={34} className="animate-pulse" /></button>
                <p className="mt-4 text-sm text-zinc-500">Emo is talking — <span className="text-emerald-600">talk over it or tap</span> to jump in</p>
              </>
            ) : busy || boot ? (
              <>
                <div className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500"><Loader2 size={34} className="animate-spin" /></div>
                <p className="mt-4 text-sm text-zinc-500">{boot ? 'Waking Emo…' : 'Thinking…'}</p>
              </>
            ) : (
              <>
                <button onClick={() => startRec()} className="flex h-24 w-24 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 transition hover:scale-105 hover:bg-emerald-500"><Mic size={34} /></button>
                <p className="mt-4 text-sm text-zinc-500">{phase === 'done' ? 'Done — tap to ask another' : 'Tap to ask'}</p>
              </>
            )}
          </div>

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
              {pendingOffer.current && <p className="flex items-center justify-center gap-1 text-xs text-zinc-400"><Hand size={11} /> say “yes” or “no”</p>}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}
