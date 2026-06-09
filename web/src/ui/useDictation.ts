import { useEffect, useRef, useState } from 'react';

/** Global dictation status so one indicator can show what's happening for whichever mic is active. */
type Phase = 'idle' | 'listening' | 'transcribing';
type Status = { listening: boolean; phase: Phase; interim: string; stop: () => void };
let status: Status = { listening: false, phase: 'idle', interim: '', stop: () => {} };
const subs = new Set<() => void>();
function setStatus(s: Partial<Status>) {
  status = { ...status, ...s };
  subs.forEach((f) => f());
}
/** True while ANY mic is recording/transcribing — used to protect modals from closing mid-dictation. */
export function isDictating(): boolean {
  return status.phase !== 'idle';
}

export function useDictationStatus(): Status {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    subs.add(f);
    return () => {
      subs.delete(f);
    };
  }, []);
  return status;
}

const SILENCE_MS = 2200; // auto-finish after this much quiet (once you've started speaking)
const MAX_MS = 90_000; // hard cap on a single dictation

/**
 * Record-then-transcribe dictation with hands-free auto-stop: tap the mic, speak, and it finalizes
 * itself when you pause (no need to reach for a Stop button). Audio is sent to the server's
 * high-accuracy engine (GPT-4o Transcribe + cleanup). onText receives the finished transcript.
 */
export function useDictation(onText: (chunk: string) => void) {
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<any>(null);
  const rafRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined' &&
    typeof (window as any).MediaRecorder !== 'undefined';

  function teardownMeter() {
    if (rafRef.current) {
      clearTimeout(rafRef.current);
      rafRef.current = null;
    }
    try {
      audioCtxRef.current?.close();
    } catch {
      /* ignore */
    }
    audioCtxRef.current = null;
  }

  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function stop() {
    teardownMeter();
    try {
      if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    } catch {
      /* ignore */
    }
  }

  /** Listen to the mic level and auto-stop after a pause (once the user has actually spoken). */
  function startSilenceWatch(stream: MediaStream) {
    try {
      const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      audioCtxRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      let lastSound = Date.now();
      let spoke = false;
      const tick = () => {
        if (!audioCtxRef.current) return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const d = data[i] - 128;
          sum += d * d;
        }
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        if (rms > 4) {
          lastSound = now;
          spoke = true;
        }
        if ((spoke && now - lastSound > SILENCE_MS) || now - startedAt > MAX_MS) {
          stop();
          return;
        }
        rafRef.current = setTimeout(tick, 120);
      };
      rafRef.current = setTimeout(tick, 250);
    } catch {
      /* no silence detection — manual stop still works */
    }
  }

  async function start() {
    if (!supported) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setStatus({ listening: false, phase: 'idle', interim: '' });
      return;
    }
    streamRef.current = stream;
    chunksRef.current = [];
    const MR: any = (window as any).MediaRecorder;
    const mime = MR.isTypeSupported?.('audio/webm') ? 'audio/webm' : MR.isTypeSupported?.('audio/mp4') ? 'audio/mp4' : '';
    const rec: MediaRecorder = mime ? new MR(stream, { mimeType: mime }) : new MR(stream);
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = async () => {
      teardownMeter();
      releaseStream();
      setListening(false);
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
      chunksRef.current = [];
      if (!blob.size) {
        setStatus({ listening: false, phase: 'idle', interim: '' });
        return;
      }
      setBusy(true);
      setStatus({ listening: false, phase: 'transcribing', interim: 'Transcribing…' });
      try {
        const ext = (rec.mimeType || '').includes('mp4') ? 'm4a' : 'webm';
        const fd = new FormData();
        fd.append('audio', blob, `dictation.${ext}`);
        const r = await fetch('/api/voice/transcribe', { method: 'POST', body: fd });
        const d = await r.json().catch(() => ({}));
        const text = (d?.text || '').trim();
        if (text) onText(text + ' ');
      } catch {
        /* ignore */
      } finally {
        setBusy(false);
        setStatus({ listening: false, phase: 'idle', interim: '' });
      }
    };
    recRef.current = rec;
    rec.start();
    startSilenceWatch(stream);
    setListening(true);
    setStatus({ listening: true, phase: 'listening', interim: '', stop });
  }

  function toggle() {
    if (!supported || busy) return;
    if (listening) stop();
    else start();
  }

  useEffect(
    () => () => {
      stop();
      releaseStream();
    },
    [],
  );

  return { supported, listening, busy, toggle, stop };
}
