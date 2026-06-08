import { useEffect, useRef, useState } from 'react';

/** Global "is something dictating right now" status, so a single indicator can show
 *  live feedback + a Stop button for whichever mic is active. */
type Status = { listening: boolean; interim: string; stop: () => void };
let status: Status = { listening: false, interim: '', stop: () => {} };
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
    return () => { subs.delete(f); };
  }, []);
  return status;
}

/** Browser voice-to-text with live (interim) feedback. onText gets each finalized chunk. */
export function useDictation(onText: (chunk: string) => void) {
  const recRef = useRef<any>(null);
  const manualStop = useRef(false);
  const [listening, setListening] = useState(false);
  const SR = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  const supported = !!SR;

  function stop() {
    manualStop.current = true;
    try { recRef.current?.stop(); } catch { /* ignore */ }
  }

  function toggle() {
    if (!supported) return;
    if (listening) { stop(); return; }
    const rec = new SR();
    // Accent matters: the US English model mishears Indian-accented speech. Default to
    // Indian English; allow a saved override (Settings can write 'dictation-lang' later).
    let lang = 'en-IN';
    try { lang = localStorage.getItem('dictation-lang') || lang; } catch { /* ignore */ }
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    manualStop.current = false;
    rec.onstart = () => { setListening(true); setStatus({ listening: true, interim: '', stop }); };
    rec.onresult = (e: any) => {
      let fin = '';
      let intm = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += t;
        else intm += t;
      }
      if (fin.trim()) onText(fin.trim() + ' ');
      setStatus({ interim: intm });
    };
    const finish = () => { setListening(false); setStatus({ listening: false, interim: '' }); };
    rec.onerror = finish;
    rec.onend = () => {
      // Some browsers (incl. mobile Safari) stop after a pause — keep going unless the user pressed Stop.
      if (!manualStop.current) {
        try { rec.start(); return; } catch { /* fall through */ }
      }
      finish();
    };
    recRef.current = rec;
    try { rec.start(); } catch { finish(); }
  }

  return { supported, listening, toggle, stop };
}
