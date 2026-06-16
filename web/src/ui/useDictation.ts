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

/**
 * Hold-to-talk dictation. While held, audio streams live to Deepgram (real-time words in the
 * indicator); on release the transcript gets a quick AI clean-up and is handed to onText. If the
 * streaming token isn't available (or streaming fails), it falls back to record-then-transcribe so
 * dictation always works. iOS-PWA-safe (PCM via Web Audio, not the unsupported Web Speech API).
 */
export function useDictation(onText: (text: string) => void) {
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const procRef = useRef<ScriptProcessorNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const preBufRef = useRef<ArrayBuffer[]>([]); // PCM captured before the socket opened
  const finalRef = useRef(''); // committed (final) transcript
  const interimRef = useRef(''); // in-progress tail
  const recRef = useRef<MediaRecorder | null>(null); // fallback recorder
  const chunksRef = useRef<Blob[]>([]);
  const modeRef = useRef<'stream' | 'batch' | null>(null);
  const capRef = useRef<any>(null);
  const startedRef = useRef(0);
  const [active, setActive] = useState(false);

  const supported =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window !== 'undefined' &&
    (typeof (window as any).AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined' || typeof (window as any).MediaRecorder !== 'undefined');

  function liveText() {
    return (finalRef.current + ' ' + interimRef.current).replace(/\s+/g, ' ').trim();
  }

  function cleanupAudio() {
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
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  async function finalize(text: string) {
    const raw = (text || '').trim();
    if (!raw) {
      setStatus({ listening: false, phase: 'idle', interim: '' });
      return;
    }
    setStatus({ listening: false, phase: 'transcribing', interim: 'Tidying up…' });
    try {
      const r = await fetch('/api/voice/clean', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: raw }) });
      const d = await r.json().catch(() => ({}));
      onText(((d?.text || raw).trim() || raw) + ' ');
    } catch {
      onText(raw + ' ');
    } finally {
      setStatus({ listening: false, phase: 'idle', interim: '' });
    }
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
      endpointing: '300',
    });
    // Deepgram temporary (grant) tokens authenticate over the 'bearer' sub-protocol (NOT 'token',
    // which is for raw API keys and 401s here). Verified against the live API.
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
        const alt = d?.channel?.alternatives?.[0];
        const t = (alt?.transcript || '').trim();
        if (d?.type === 'Results' && t) {
          if (d.is_final) {
            finalRef.current = (finalRef.current + ' ' + t).replace(/\s+/g, ' ').trim();
            interimRef.current = '';
          } else {
            interimRef.current = t;
          }
          setStatus({ interim: liveText() });
        }
      } catch {
        /* ignore non-JSON */
      }
    };
  }

  function startProcessor(stream: MediaStream, onPcm: (b: ArrayBuffer) => void) {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new AC();
    ctxRef.current = ctx;
    ctx.resume().catch(() => undefined);
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    procRef.current = proc;
    const mute = ctx.createGain();
    mute.gain.value = 0; // route to destination silently so onaudioprocess fires without echo
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
    if (active) return;
    finalRef.current = '';
    interimRef.current = '';
    preBufRef.current = [];
    modeRef.current = null;
    setActive(true);
    setStatus({ listening: true, phase: 'listening', interim: '', stop });
    startedRef.current = Date.now();

    // Ask for a streaming token in parallel with mic permission.
    const tokenP = fetch('/api/voice/stream-token', { method: 'POST' })
      .then((r) => r.json())
      .catch(() => ({ available: false }));

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } as any });
    } catch {
      setActive(false);
      setStatus({ listening: false, phase: 'idle', interim: '' });
      return;
    }
    streamRef.current = stream;

    const tok: any = await tokenP;
    const canStream = !!tok?.available && !!tok?.token && typeof (window as any).AudioContext !== 'undefined';

    if (canStream) {
      modeRef.current = 'stream';
      try {
        const rate = startProcessor(stream, (b) => {
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(b);
          else preBufRef.current.push(b);
        });
        openSocket(tok.token, tok.model, rate);
      } catch {
        modeRef.current = 'batch';
      }
    }

    if (modeRef.current !== 'stream') {
      // Fallback: record the whole clip, transcribe on release.
      modeRef.current = 'batch';
      try {
        const MR: any = (window as any).MediaRecorder;
        const mime = MR?.isTypeSupported?.('audio/webm') ? 'audio/webm' : MR?.isTypeSupported?.('audio/mp4') ? 'audio/mp4' : '';
        const rec: MediaRecorder = mime ? new MR(stream, { mimeType: mime }) : new MR(stream);
        chunksRef.current = [];
        rec.ondataavailable = (e: BlobEvent) => {
          if (e.data?.size) chunksRef.current.push(e.data);
        };
        recRef.current = rec;
        rec.start();
      } catch {
        /* no recorder either — give up quietly */
        cleanupAudio();
        setActive(false);
        setStatus({ listening: false, phase: 'idle', interim: '' });
        return;
      }
    }

    // Safety cap.
    capRef.current = setTimeout(() => stop(), MAX_MS);
  }

  async function stop() {
    if (!active) return;
    setActive(false);
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }

    if (modeRef.current === 'batch') {
      const rec = recRef.current;
      recRef.current = null;
      const blob = await new Promise<Blob>((resolve) => {
        if (!rec || rec.state === 'inactive') return resolve(new Blob(chunksRef.current, { type: 'audio/webm' }));
        rec.onstop = () => resolve(new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' }));
        try {
          rec.stop();
        } catch {
          resolve(new Blob(chunksRef.current, { type: 'audio/webm' }));
        }
      });
      cleanupAudio();
      chunksRef.current = [];
      if (!blob.size) {
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
      return;
    }

    // streaming: tell Deepgram we're done, gather trailing finals, then clean + insert.
    const ws = wsRef.current;
    wsRef.current = null;
    cleanupAudio(); // stop capturing immediately on release
    const done = () => finalize(liveText());
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        done();
      };
      ws.addEventListener('close', finish);
      try {
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        /* ignore */
      }
      setTimeout(finish, 1500); // don't wait forever for trailing finals
    } else {
      done();
    }
  }

  useEffect(
    () => () => {
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      cleanupAudio();
    },
    [],
  );

  return { supported, active, listening: active, start, stop };
}
