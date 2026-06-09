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

/**
 * Record-then-transcribe dictation. Records mic audio in the browser, then sends it to the
 * server's high-accuracy speech-to-text engine (GPT-4o Transcribe + cleanup) — far better than
 * the old browser SpeechRecognition. onText receives the finished, cleaned transcript.
 */
export function useDictation(onText: (chunk: string) => void) {
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined' &&
    typeof (window as any).MediaRecorder !== 'undefined';

  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  function stop() {
    try {
      if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop();
    } catch {
      /* ignore */
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
