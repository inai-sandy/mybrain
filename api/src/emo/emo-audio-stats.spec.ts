import * as fs from 'fs';
import * as path from 'path';
import { audioStats, denoiseLine, deviceHandledLevel, feTag, wordCount, PASS_OFF_REASON } from './emo-audio-stats';

const FIX = path.join(__dirname, 'fixtures', 'denoise');

/** The PCM inside a WAV (walks the chunks — never assumes a 44-byte header). */
function wavData(p: string): { sr: number; pcm: Buffer } {
  const b = fs.readFileSync(p);
  const sr = b.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'data') return { sr, pcm: b.subarray(off + 8, off + 8 + len) };
    off += 8 + len;
  }
  throw new Error('no data chunk');
}

/** Deterministic white hiss mixed in at a given SNR (speech RMS / noise RMS over the whole clip). */
function withHiss(pcm: Buffer, snrDb: number): Buffer {
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const n = pcm.length >> 1;
  let s = 0;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2); s += v * v; }
  const noiseRms = Math.sqrt(s / n) / Math.pow(10, snrDb / 20);
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < n; i++) {
    let v = Math.round(pcm.readInt16LE(i * 2) + gauss() * noiseRms);
    if (v > 32767) v = 32767; if (v < -32768) v = -32768;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

describe('the audio ruler (BEA-1622)', () => {
  const clean = wavData(path.join(FIX, 'clean-16k.wav'));
  const pendant = wavData(path.join(FIX, 'pendant-hiss-2026-09-05.wav'));

  it('reads clean speech as a deep floor with the words far above it', () => {
    const s = audioStats(clean.pcm, clean.sr);
    expect(s.seconds).toBeCloseTo(19.1, 0);
    expect(s.floorDbfs).toBeLessThan(-55);
    expect(s.speechDbfs).toBeGreaterThan(-20);
    expect(s.snrDb).toBeGreaterThan(35);
    expect(s.frames).toBeGreaterThan(900);
  });

  it('reads the hiss that was mixed in: 14 dB SNR hiss lifts the floor to about -34 dBFS', () => {
    // the synthetic fixture: clean speech + white hiss at the level the owner reported
    const s = audioStats(withHiss(clean.pcm, 14), clean.sr);
    expect(s.floorDbfs).toBeGreaterThan(-37);
    expect(s.floorDbfs).toBeLessThan(-30);
    expect(s.snrDb).toBeGreaterThanOrEqual(12);
    expect(s.snrDb).toBeLessThanOrEqual(22);
  });

  it("diagnoses the owner's pendant clip as speech sitting on the floor, not hiss over clear speech", () => {
    // turn-1788586263469.wav — the "25 s → a few words" take. Its floor is -41 dBFS and its
    // speech only ~16 dB above it; that gap, not the hiss, is why every denoiser lost words on it
    // (specs/briefs/BEA-1622.md). A pass may only ever be considered when the gap is >= 20 dB.
    const s = audioStats(pendant.pcm, pendant.sr);
    expect(s.seconds).toBeCloseTo(22.4, 0);
    expect(Math.abs(s.floorDbfs - -41)).toBeLessThanOrEqual(2);
    expect(Math.abs(s.speechDbfs - -25)).toBeLessThanOrEqual(2);
    expect(s.snrDb).toBeLessThan(20);
  });

  it('never reads silence or a stub as -Infinity', () => {
    expect(audioStats(Buffer.alloc(3200)).floorDbfs).toBe(-96);
    expect(audioStats(Buffer.alloc(0))).toEqual({ seconds: 0, floorDbfs: -96, speechDbfs: -96, snrDb: 0, frames: 0 });
    expect(audioStats(Buffer.alloc(10)).frames).toBe(0);
  });

  it('prints the one line per turn the issue asked for', () => {
    const before = { seconds: 22.4, floorDbfs: -41, speechDbfs: -25, snrDb: 16, frames: 1119 };
    expect(denoiseLine({ before, applied: false, reason: PASS_OFF_REASON, fe: null, words: 31 })).toBe(
      '[emo] denoise: floor -41.0 dBFS → -41.0, applied no (server pass off: measured no gain, BEA-1622), speech -25.0 dBFS, snr 16 dB, 22.4s, fe none, words 31',
    );
    const after = { ...before, floorDbfs: -61.2 };
    expect(denoiseLine({ before, after, applied: true, reason: 'floor above -45', fe: 'ns1agc', words: 40 })).toBe(
      '[emo] denoise: floor -41.0 dBFS → -61.2, applied yes (floor above -45), speech -25.0 dBFS, snr 16 dB, 22.4s, fe ns1agc, words 40',
    );
  });

  it('counts words and reads the front-end tag safely', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  ')).toBe(0);
    expect(wordCount('call the\nsupplier  tomorrow')).toBe(4);
    expect(feTag('ns1agc')).toBe('ns1agc');
    expect(feTag(' NS1AGC ')).toBe('ns1agc');
    expect(feTag('../etc')).toBeNull();
    expect(feTag('')).toBeNull();
    expect(feTag(undefined)).toBeNull();
    expect(feTag('a'.repeat(17))).toBeNull();
    expect(deviceHandledLevel('ns1agc')).toBe(true);
    expect(deviceHandledLevel(null)).toBe(false);
    expect(deviceHandledLevel('other')).toBe(false);
  });
});
