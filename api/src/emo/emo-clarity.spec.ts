import * as fs from 'fs';
import * as path from 'path';
import { clarityChain, highPass, presenceShelf, levelToTarget, levelOnly, speechLevelDbfs, SPEECH_TARGET_DBFS, HPF_HZ } from './emo-clarity';
import { normalizePcm } from './emo-device.service';

/* The V1 clarity chain the owner picked by ear (2026-09-11). Each step is measured on tones so a
   coefficient typo cannot ship; the whole chain is measured on his real hissy pendant clip. */
const SR = 16000;
const tone = (hz: number, secs = 1, amp = 0.3) => Float64Array.from({ length: SR * secs }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const rmsDb = (x: Float64Array, from = Math.floor(x.length / 2)) => { let sq = 0; for (let i = from; i < x.length; i++) sq += x[i] * x[i]; return 20 * Math.log10(Math.sqrt(sq / (x.length - from))); };
const gainDb = (hz: number, step: (x: Float64Array) => void) => { const x = tone(hz); const before = rmsDb(x); step(x); return rmsDb(x) - before; };
const pcmOf = (x: Float64Array) => { const b = Buffer.alloc(x.length * 2); x.forEach((v, i) => b.writeInt16LE(Math.round(v * 32767), i * 2)); return b; };
const floatOf = (b: Buffer) => Float64Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2) / 32768);

describe('clarity chain — step 1, the 200 Hz high-pass', () => {
  it('takes handling rumble out and leaves speech alone', () => {
    expect(HPF_HZ).toBe(200);
    expect(gainDb(50, highPass)).toBeLessThan(-40);
    expect(gainDb(100, highPass)).toBeLessThan(-20);
    expect(gainDb(200, highPass)).toBeCloseTo(-6, 0);          // the corner, two Butterworth sections
    expect(Math.abs(gainDb(600, highPass))).toBeLessThan(0.5);
    expect(Math.abs(gainDb(1000, highPass))).toBeLessThan(0.2);
    expect(Math.abs(gainDb(3000, highPass))).toBeLessThan(0.2);
  });
});

describe('clarity chain — step 2, the presence shelf', () => {
  it('lifts the top by about +5 dB and leaves the low band alone', () => {
    expect(gainDb(6000, presenceShelf)).toBeGreaterThan(4);
    expect(gainDb(6000, presenceShelf)).toBeLessThan(6);
    expect(Math.abs(gainDb(300, presenceShelf))).toBeLessThan(0.5);
    expect(Math.abs(gainDb(1000, presenceShelf))).toBeLessThan(1.5);
  });
});

describe('clarity chain — step 3, the level', () => {
  it('puts the loud 10% of frames on the target and never clips', () => {
    expect(SPEECH_TARGET_DBFS).toBe(-16);
    const x = new Float64Array(SR);                                  // 0.9 s near-silence, 0.1 s of speech at -40 dBFS
    for (let i = 0; i < SR; i++) x[i] = i < SR * 0.9 ? (i % 2 ? 0.0006 : -0.0006) : (i % 2 ? 0.01 : -0.01);
    expect(levelToTarget(x)).toBe(true);
    expect(speechLevelDbfs(x)).toBeCloseTo(-16, 0);
    expect(Math.max(...Array.from(x).map(Math.abs))).toBeLessThanOrEqual(1);
  });
  it('lowers a take that is too hot as well as lifting a quiet one', () => {
    const x = tone(1000, 1, 0.9);
    expect(levelToTarget(x)).toBe(true);
    expect(speechLevelDbfs(x)).toBeCloseTo(-16, 0);
  });
  it('leaves silence alone — a quiet room is never lifted into hiss', () => {
    const x = new Float64Array(SR);
    expect(levelToTarget(x)).toBe(false);
    expect(clarityChain(pcmOf(x))).toEqual(pcmOf(x));
  });
  it('one click no longer defeats it: speech at -27 dBFS with a full-scale transient still comes up', () => {
    const x = Float64Array.from({ length: SR }, (_, i) => (i % 2 ? 0.0447 : -0.0447));
    x[8000] = 0.66;
    expect(levelToTarget(x)).toBe(true);
    expect(speechLevelDbfs(x)).toBeCloseTo(-16, 0);
    expect(Math.abs(x[8000])).toBeLessThan(1);
  });
});

describe('clarity chain — the whole thing', () => {
  it('a buffer shorter than one frame comes back untouched', () => {
    const b = Buffer.alloc(100, 7);
    expect(clarityChain(b)).toBe(b);
  });
  it("normalizePcm IS the chain (three callers and two specs know that name)", () => {
    const x = tone(1000, 1, 0.05); x.forEach((v, i) => { x[i] = v + 0.2 * Math.sin((2 * Math.PI * 40 * i) / SR); });   // speech + rumble
    expect(normalizePcm(pcmOf(x))).toEqual(clarityChain(pcmOf(x)));
  });
  it('levelOnly does not EQ — synthesised speech keeps its low end', () => {
    const rumble = tone(40, 1, 0.2);
    const out = floatOf(levelOnly(pcmOf(rumble)));
    expect(rmsDb(out)).toBeGreaterThan(-20);                         // still there, just levelled
    const chained = floatOf(clarityChain(pcmOf(rumble)));
    expect(rmsDb(chained)).toBeLessThan(rmsDb(out) - 30);            // the chain would have removed it
  });
  it('on a rumble-dominated take (his 11 Sept shape) the chain GAINS SNR', () => {
    /* speech at -30 dBFS + 40 Hz handling rumble at -20 dBFS: the shape of the owner's in-hand take */
    const x = Float64Array.from({ length: SR * 2 }, (_, i) => 0.03 * Math.sin((2 * Math.PI * 1000 * i) / SR) * (Math.floor(i / 1600) % 2) + 0.1 * Math.sin((2 * Math.PI * 40 * i) / SR));
    const floor = (y: Float64Array) => { const f = 320, r: number[] = []; for (let i = 0; i + f <= y.length; i += f) { let s = 0; for (let j = 0; j < f; j++) s += y[i + j] ** 2; r.push(Math.sqrt(s / f)); } r.sort((a, b) => a - b); return 20 * Math.log10(r[Math.floor(r.length * 0.1)] + 1e-9); };
    const after = floatOf(clarityChain(pcmOf(x)));
    expect(speechLevelDbfs(after) - floor(after)).toBeGreaterThan(speechLevelDbfs(x) - floor(x) + 10);
  });
  it("on the owner's real HISS clip (5 Sept, the 37.5 dB era) the shelf costs at most 2 dB of SNR — the crispness trade he chose by ear", () => {
    const wav = fs.readFileSync(path.join(__dirname, 'fixtures', 'denoise', 'pendant-hiss-2026-09-05.wav'));
    const pcm = wav.subarray(44);
    const before = floatOf(pcm), after = floatOf(clarityChain(pcm));
    const floor = (x: Float64Array) => { const f = 320, r: number[] = []; for (let i = 0; i + f <= x.length; i += f) { let s = 0; for (let j = 0; j < f; j++) s += x[i + j] ** 2; r.push(Math.sqrt(s / f)); } r.sort((a, b) => a - b); return 20 * Math.log10(r[Math.floor(r.length * 0.1)] + 1e-9); };
    const snrBefore = speechLevelDbfs(before) - floor(before), snrAfter = speechLevelDbfs(after) - floor(after);
    expect(speechLevelDbfs(after)).toBeCloseTo(SPEECH_TARGET_DBFS, 0);
    expect(snrAfter).toBeGreaterThanOrEqual(snrBefore - 2);   // measured 16.0 → 14.4: the +5 dB shelf lifts hiss with the consonants
    let peak = 0; for (let i = 0; i < after.length; i++) peak = Math.max(peak, Math.abs(after[i]));
    expect(peak).toBeLessThanOrEqual(1);
  });
});
