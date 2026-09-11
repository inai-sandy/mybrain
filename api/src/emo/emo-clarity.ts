/* emo-clarity.ts — the "V1" clarity chain every device take goes through, as pure functions.
 *
 * 2026-09-11, chosen BY EAR by the owner on his own pendant take (three server-side candidates of the
 * same recording in his library; V1 won, V2 = V1 + compression lost). On that take, made in his hand:
 * noise floor -34 dBFS with the excess at 20-150 Hz (handling rumble) and "dull, too quiet, uneven".
 * The chain, in order — and the order matters, the level step must see the EQ'd signal:
 *
 *   1. high-pass 200 Hz, two Butterworth sections — the rumble out (floor -34 → -43 dBFS on his take).
 *      Speech intelligibility lives at 300-3400 Hz; a phone line cuts at 300.
 *   2. high shelf +5 dB from 2.5 kHz — "crisp". A pendant mic behind a case hole and the WebRTC
 *      suppressor both dull the top; this gives it back without touching the noise band below.
 *   3. speech level to -16 dBFS RMS (the loud 10% of 20 ms frames) with a soft limiter above 0.7 FS.
 *      ONE static gain per file — never an AGC, never a second gain stage that could pump. The old
 *      target was -20; he still called that "too quiet".
 *
 * Every step is pure and int16-in/int16-out so `normalizePcm()` stays a drop-in. The pendant does step 1
 * on the device too since 0.3.11 (pendant_hpf.h — same coefficients); doing it here again only makes
 * the roll-off steeper, and it means a device WITHOUT that filter still gets it once.
 *
 * Checked before shipping: the raw take and the V1 take transcribe to the same 19 words on the live
 * engine (gpt-transcribe) — the chain costs the transcriber nothing.
 */

export const CLARITY_SAMPLE_RATE = 16000;
export const HPF_HZ = 200;
export const SHELF_HZ = 2500;
export const SHELF_DB = 5;
/** Where the loud 10% of frames (the speech) lands. -16 dBFS RMS is ordinary playback loudness for
 *  speech; the old -20 left the owner saying "too quiet". */
export const SPEECH_TARGET_DBFS = -16;
export const NORMALISE_MAX_GAIN = 16;                   // +24 dB: a very quiet take is lifted, silence is not turned into hiss
const KNEE = 0.7;                                       // the soft limiter bends above this (FS) toward CEILING
const CEILING = 0.98;

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function highPassCoeffs(hz: number, sr: number, q = Math.SQRT1_2): Biquad {
  const w0 = (2 * Math.PI * hz) / sr, a = Math.sin(w0) / (2 * q), c = Math.cos(w0), a0 = 1 + a;
  return { b0: (1 + c) / 2 / a0, b1: -(1 + c) / a0, b2: (1 + c) / 2 / a0, a1: (-2 * c) / a0, a2: (1 - a) / a0 };
}
function highShelfCoeffs(hz: number, gainDb: number, sr: number, slope = 0.9): Biquad {
  const A = Math.pow(10, gainDb / 40), w0 = (2 * Math.PI * hz) / sr, c = Math.cos(w0);
  const al = (Math.sin(w0) / 2) * Math.sqrt((A + 1 / A) * (1 / slope - 1) + 2), sa = 2 * Math.sqrt(A) * al;
  const b0 = A * (A + 1 + (A - 1) * c + sa), b1 = -2 * A * (A - 1 + (A + 1) * c), b2 = A * (A + 1 + (A - 1) * c - sa);
  const a0 = A + 1 - (A - 1) * c + sa, a1 = 2 * (A - 1 - (A + 1) * c), a2 = A + 1 - (A - 1) * c - sa;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}
/** run one biquad over a float signal, in place */
function runBiquad(x: Float64Array, k: Biquad): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i], o = k.b0 * v + k.b1 * x1 + k.b2 * x2 - k.a1 * y1 - k.a2 * y2;
    x2 = x1; x1 = v; y2 = y1; y1 = o; x[i] = o;
  }
}

function toFloat(pcm: Buffer): Float64Array {
  const n = Math.floor(pcm.length / 2), x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm.readInt16LE(i * 2) / 32768;
  return x;
}
function toPcm(x: Float64Array): Buffer {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  return out;
}

/** step 1 — two Butterworth high-pass sections at HPF_HZ (50 Hz ≈ -48 dB, 200 Hz -6 dB, flat above 600) */
export function highPass(x: Float64Array, sr = CLARITY_SAMPLE_RATE): void {
  const k = highPassCoeffs(HPF_HZ, sr);
  runBiquad(x, k); runBiquad(x, k);
}
/** step 2 — the presence shelf, +SHELF_DB above SHELF_HZ */
export function presenceShelf(x: Float64Array, sr = CLARITY_SAMPLE_RATE): void {
  runBiquad(x, highShelfCoeffs(SHELF_HZ, SHELF_DB, sr));
}
/** the loud 10% of 20 ms frames, in dBFS RMS — the "speech level" the target is measured on */
export function speechLevelDbfs(x: Float64Array, sr = CLARITY_SAMPLE_RATE): number {
  const frame = Math.round(sr * 0.02), rms: number[] = [];
  for (let i = 0; i + frame <= x.length; i += frame) {
    let sq = 0; for (let j = 0; j < frame; j++) sq += x[i + j] * x[i + j];
    rms.push(Math.sqrt(sq / frame));
  }
  if (!rms.length) return -Infinity;
  rms.sort((a, b) => a - b);
  const v = rms[Math.floor(rms.length * 0.9)] || 0;
  return v > 0 ? 20 * Math.log10(v) : -Infinity;
}
/** step 3 — one static gain that puts the speech level on SPEECH_TARGET_DBFS, then the soft limiter.
 *  Returns false when nothing was done (silence, or already at level) so a caller can keep the input. */
export function levelToTarget(x: Float64Array, sr = CLARITY_SAMPLE_RATE): boolean {
  const speech = speechLevelDbfs(x, sr);
  if (!Number.isFinite(speech) || speech < -90) return false;
  let gain = Math.pow(10, (SPEECH_TARGET_DBFS - speech) / 20);
  if (gain > NORMALISE_MAX_GAIN) gain = NORMALISE_MAX_GAIN;
  if (gain <= 1.05 && gain >= 0.95) return false;
  for (let i = 0; i < x.length; i++) {
    let v = x[i] * gain;
    const a = Math.abs(v);
    if (a > KNEE) v = Math.sign(v) * (KNEE + (CEILING - KNEE) * Math.tanh((a - KNEE) / (CEILING - KNEE)));
    x[i] = v;
  }
  return true;
}

/** The whole chain on 16-bit PCM: high-pass → presence shelf → level. A buffer shorter than one 20 ms
 *  frame is returned untouched (nothing to measure); silence is returned untouched (never lifted into hiss). */
export function clarityChain(pcm: Buffer, sr = CLARITY_SAMPLE_RATE): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (n < Math.round(sr * 0.02)) return pcm;
  const x = toFloat(pcm);
  if (speechLevelDbfs(x, sr) < -90) return pcm;         // silence: the EQ has nothing to work on and the level step would not run
  highPass(x, sr);
  presenceShelf(x, sr);
  levelToTarget(x, sr);
  return toPcm(x);
}

/** Level only (no EQ) — for synthesised speech, which has no rumble and no dull mic to correct. */
export function levelOnly(pcm: Buffer, sr = CLARITY_SAMPLE_RATE): Buffer {
  const n = Math.floor(pcm.length / 2);
  if (n < Math.round(sr * 0.02)) return pcm;
  const x = toFloat(pcm);
  return levelToTarget(x, sr) ? toPcm(x) : pcm;
}
