/* whisper-rescue.ts — WHEN a second engine may overrule the first, as pure functions.
 *
 * 2026-09-10, measured on the owner's own recordings: gpt-transcribe (the engine that wins on his
 * mixed Telugu/English) came back with 3 words for a quiet 1.5 m take a person could plainly hear;
 * whisper-1 gave the 60 real words. But whisper also INVENTS on near-silent audio — "If you enjoyed
 * the video, please subscribe", a Korean "thanks for watching", "This is the end of my presentation"
 * — and it collapses on Telugu. So whisper is consulted only when gpt came back near-empty, and its
 * answer is believed only when it was confident and heard a language the owner speaks.
 *
 * Replayed over all 50 recordings on the server before shipping: the guarded rule rescues 2 (the
 * quiet take 3→60, a 20 s take 0→23) and invents 0; every take that gpt handled is left alone.
 * The six switched/rejected takes are the fixtures in whisper-rescue.spec.ts. */

/** gpt's answer is implausibly short for the audio: fewer than ~1 word per 3 s (and under 2 words). */
export function gptTooShort(gptText: string, secs: number): boolean {
  if (!Number.isFinite(secs)) return false;               /* unknown length: never consult a second engine */
  const g = wordCount(gptText);
  return g < Math.max(2, 0.35 * Math.max(1, secs));
}

/** What whisper-1 returns with response_format=verbose_json — only the fields the guard reads. */
export type WhisperVerbose = {
  text?: string;
  language?: string;
  segments?: { avg_logprob?: number; no_speech_prob?: number; compression_ratio?: number }[];
};

export const RESCUE_MIN_LOGPROB = -0.7;                 /* whisper's own confidence: the fakes sat at -0.78 … -0.99, the real ones at -0.54 / -0.59 */
export const RESCUE_LANGUAGES = new Set(['english', 'telugu', 'en', 'te']);

export type RescueVerdict = { accept: boolean; why: string; text: string; logprob: number; language: string };

/** Believe whisper only when: confident, a language the owner speaks, clearly more words than gpt,
 *  a real speaking rate, and not the same few words repeated. */
export function judgeRescue(v: WhisperVerbose, gptText: string, secs: number): RescueVerdict {
  const text = (v?.text || '').trim();
  const segs = Array.isArray(v?.segments) ? v.segments : [];
  const logprob = segs.length ? segs.reduce((a, s) => a + (s.avg_logprob ?? -9), 0) / segs.length : -9;
  const language = String(v?.language || '').toLowerCase();
  const w = wordCount(text), g = wordCount(gptText);
  const s = Math.max(1, secs);
  const no = (why: string): RescueVerdict => ({ accept: false, why, text, logprob, language });
  if (!Number.isFinite(secs) || secs <= 0) return no('no usable audio length');   /* standalone-safe: NaN must never pass the rate check */
  if (!text) return no('whisper returned nothing');
  if (logprob < RESCUE_MIN_LOGPROB) return no(`whisper not confident (log-prob ${logprob.toFixed(2)})`);
  if (!RESCUE_LANGUAGES.has(language)) return no(`whisper heard "${language || '?'}", not a language the owner speaks`);
  if (w < 3 * Math.max(1, g)) return no(`whisper ${w} words is not clearly more than gpt ${g}`);
  if (w / s < 0.5) return no(`whisper ${w} words over ${s.toFixed(0)} s is not a speaking rate`);
  if (uniqueRatio(text) < 0.4) return no('whisper repeated the same few words');
  return { accept: true, why: `gpt ${g} words too short for ${s.toFixed(0)} s; whisper ${w} words, log-prob ${logprob.toFixed(2)}, ${language}`, text, logprob, language };
}

export function wordCount(s: string): number {
  const t = (s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}
function uniqueRatio(s: string): number {
  const w = s.toLowerCase().split(/\s+/).filter(Boolean);
  return w.length ? new Set(w).size / w.length : 0;
}
