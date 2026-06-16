import { useEffect, useRef, useState } from 'react';

/** Global dictation status so one floating indicator can show the live transcript for the active mic. */
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

const MAX_MS = 120_000; // hard safety cap on a single hold

/** Instant, no-network tidy: drop the most common spoken fillers + de-dupe immediate repeats.
 *  (Deepgram smart_format already handles caps/punctuation/numbers.) */
function tidy(t: string): string {
  return (t || '')
    .replace(/\b(?:um+|uh+|er+|ah+|hmm+|mm+|uhh+|erm+)\b[,]?/gi, '')
    .replace(/\b(\w+)(\s+\1\b)+/gi, '$1') // "the the the" -> "the"
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s*[,.]?\s*/, '')
    .trim();
}

/**
 * Hold-to-talk dictation. Held → audio streams live to Deepgram (real-time words) AND is recorded
 * in parallel as a safety net. On release: if streaming produced text it's cleaned + inserted; if it
 * produced nothing (streaming unavailable/blocked), the recorded clip is transcribed instead — so
 * your words are never lost. iOS-PWA-safe: the AudioContext is woken inside the press gesture.
 */
export function useDictation(onText: (text: string) => void) {
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const preBufRef = useRef<ArrayBuffer[]>([]); // PCM captured before the socket opened
  const finalRef = useRef(''); // committed (final) transcript
  const interimRef = useRef(''); // in-progress tail
  const recRef = useRef<MediaRecorder | null>(null); // parallel safety recording
  const chunksRef = useRef<Blob[]>([]);
  const modeRef = useRef<'stream' | 'batch' | null>(null);
  const capRef = useRef<any>(null);
  const runningRef = useRef(false); // synchronous guard (React state can be stale in event closures)
  const [active, setActive] = useState(false);

  const supported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof window !== 'undefined' && typeof (window as any).MediaRecorder !== 'undefined';

  function liveText() {
    return (finalRef.current + ' ' + interimRef.current).replace(/\s+/g, ' ').trim();
  }

  /** Stop PCM capture + close the audio context, but leave the mic stream tracks for the recorder. */
  function stopCapture() {
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }
    try {
      procRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    procRef.current = null;
    try {
      ctxRef.current?.close();
    } catch {
      /* ignore */
    }
    ctxRef.current = null;
  }
  function releaseStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function batchTranscribe(blob: Blob) {
    if (!blob || !blob.size) {
      setStatus({ listening: false, phase: 'idle', interim: '' });
      return;
    }
    setStatus({ listening: false, phase: 'transcribing', interim: 'Transcribing…' });
    try {
      const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
      const fd = new FormData();
      fd.append('audio', blob, `dictation.${ext}`);
      const r = await fetch('/api/voice/transcribe', { method: 'POST', body: fd });
      const d = await r.json().catch(() => ({}));
      const text = (d?.text || '').trim();
      if (text) onText(text + ' ');
    } catch {
      /* ignore */
    } finally {
      setStatus({ listening: false, phase: 'idle', interim: '' });
    }
  }

  // ---- parallel safety recorder ----
  function startRecorder(stream: MediaStream) {
    try {
      const MR: any = (window as any).MediaRecorder;
      if (!MR) {
        recRef.current = null;
        return;
      }
      const mime = MR.isTypeSupported?.('audio/webm') ? 'audio/webm' : MR.isTypeSupported?.('audio/mp4') ? 'audio/mp4' : '';
      const rec: MediaRecorder = mime ? new MR(stream, { mimeType: mime }) : new MR(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e: BlobEvent) => {
        if (e.data?.size) chunksRef.current.push(e.data);
      };
      recRef.current = rec;
      rec.start();
    } catch {
      recRef.current = null;
    }
  }
  function stopRecorder(): Promise<Blob> {
    const rec = recRef.current;
    recRef.current = null;
    return new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') return resolve(new Blob(chunksRef.current, { type: 'audio/webm' }));
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }));
      try {
        rec.stop();
      } catch {
        resolve(new Blob(chunksRef.current, { type: 'audio/webm' }));
      }
    });
  }

  // ---- streaming (Deepgram) ----
  function openSocket(token: string, model: string, sampleRate: number) {
    const params = new URLSearchParams({
      model: model || 'nova-3',
      encoding: 'linear16',
      sample_rate: String(Math.round(sampleRate)),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: '400',
    });
    // Deepgram temporary (grant) tokens authenticate over the 'bearer' sub-protocol (NOT 'token').
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, ['bearer', token]);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;
    ws.onopen = () => {
      for (const b of preBufRef.current) {
        try {
          ws.send(b);
        } catch {
          /* ignore */
        }
      }
      preBufRef.current = [];
    };
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d?.type !== 'Results') return;
        const t = (d?.channel?.alternatives?.[0]?.transcript || '').trim();
        if (!t) return;
        if (d.is_final) {
          finalRef.current = (finalRef.current + ' ' + t).replace(/\s+/g, ' ').trim();
          interimRef.current = '';
        } else {
          interimRef.current = t;
        }
        setStatus({ interim: liveText() });
      } catch {
        /* ignore non-JSON */
      }
    };
  }

  function attachProcessor(ctx: AudioContext, stream: MediaStream, onPcm: (b: ArrayBuffer) => void): number {
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    procRef.current = proc;
    const mute = ctx.createGain();
    mute.gain.value = 0; // silent route to destination so onaudioprocess fires without echo
    proc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      onPcm(pcm.buffer);
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination);
    return ctx.sampleRate;
  }

  async function start() {
    if (runningRef.current) return;
    runningRef.current = true;
    finalRef.current = '';
    interimRef.current = '';
    preBufRef.current = [];
    chunksRef.current = [];
    modeRef.current = null;
    setActive(true);
    setStatus({ listening: true, phase: 'listening', interim: '', stop });

    // 1) Wake the audio engine INSIDE the gesture (before any await) — iOS keeps it suspended otherwise.
    let ctx: AudioContext | null = null;
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (AC) {
      try {
        ctx = new AC();
        ctxRef.current = ctx;
        void ctx.resume?.();
      } catch {
        ctx = null;
        ctxRef.current = null;
      }
    }

    // 2) Ask for a streaming token in parallel with the mic permission.
    const tokenP = fetch('/api/voice/stream-token', { method: 'POST' })
      .then((r) => r.json())
      .catch(() => ({ available: false }));

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } as any });
    } catch {
      stopCapture();
      runningRef.current = false;
      setActive(false);
      setStatus({ listening: false, phase: 'idle', interim: '' });
      return;
    }
    streamRef.current = stream;

    const tok: any = await tokenP;
    const canStream = !!tok?.available && !!tok?.token && !!ctx;
    if (canStream && ctx) {
      modeRef.current = 'stream';
      try {
        const rate = attachProcessor(ctx, stream, (b) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(b);
          else preBufRef.current.push(b);
        });
        void ctx.resume?.();
        openSocket(tok.token, tok.model, rate);
      } catch {
        modeRef.current = 'batch';
      }
    }
    if (modeRef.current !== 'stream') {
      // No live streaming available → record the clip and transcribe on release (only here do we use the mic recorder).
      modeRef.current = 'batch';
      try {
        ctx?.close();
      } catch {
        /* ignore */
      }
      ctxRef.current = null;
      startRecorder(stream);
    }

    capRef.current = setTimeout(() => stop(), MAX_MS);
  }

  async function stop() {
    if (!runningRef.current) return;
    runningRef.current = false;
    setActive(false);
    const wasStream = modeRef.current === 'stream';
    // Drop the "Listening" UI the instant we stop (don't keep it up while finishing).
    setStatus({ listening: false, phase: 'transcribing', interim: wasStream ? liveText() || 'Finishing…' : 'Transcribing…' });
    stopCapture();

    if (wasStream) {
      releaseStream(); // mic OFF immediately — single consumer, nothing else holding it
      const ws = wsRef.current;
      wsRef.current = null;
      await new Promise<void>((resolve) => {
        if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) return resolve();
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          resolve();
        };
        ws.addEventListener('close', fin);
        try {
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        } catch {
          /* ignore */
        }
        setTimeout(fin, 800);
      });
      const streamed = liveText();
      if (streamed.replace(/\s/g, '').length >= 1) onText(tidy(streamed) + ' ');
      setStatus({ listening: false, phase: 'idle', interim: '' });
      return;
    }

    // batch (no live streaming): flush the recording first, then release the mic + transcribe.
    const blob = await stopRecorder();
    releaseStream();
    chunksRef.current = [];
    await batchTranscribe(blob);
  }

  useEffect(
    () => () => {
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      stopCapture();
      releaseStream();
    },
    [],
  );

  return { supported, active, listening: active, start, stop };
}
