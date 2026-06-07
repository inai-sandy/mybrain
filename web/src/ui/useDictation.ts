import { useRef, useState } from 'react';

/** Browser voice-to-text (Web Speech API). Returns {supported, listening, toggle}; no-ops gracefully when unsupported. */
export function useDictation(onText: (chunk: string) => void) {
  const recRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const SR = typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;
  const supported = !!SR;

  function toggle() {
    if (!supported) return;
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = new SR();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e: any) => {
      let chunk = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) chunk += e.results[i][0].transcript;
      }
      if (chunk.trim()) onText(chunk.trim() + ' ');
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    rec.start();
    setListening(true);
  }
  return { supported, listening, toggle };
}
