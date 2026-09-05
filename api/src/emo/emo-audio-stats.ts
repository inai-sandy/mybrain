/**
 * The audio ruler for device turns (BEA-1622) — pure functions, no I/O.
 *
 * Every /emo/device/turn is measured before it is transcribed, and ONE log line per turn says what
 * the transcriber was given: the pause floor, the speech level, their gap (SNR), the length, the
 * device front-end tag and, once known, the transcriber's word count. These numbers are the diagnosis
 * of a bad clip — "hiss on top of clear speech" (a filter can help) vs "speech sitting on the floor"
 * (nothing on the server helps; the mic did not capture it).
 *
 * The noise-reduction pass this issue was opened for is deliberately NOT here: measured on the owner's
 * own hissy pendant clip and on synthetic 14 dB-SNR hiss, Deepgram nova-3 gained nothing from eight
 * denoise variants and lost words on the real clip (specs/briefs/BEA-1622.md has the table). The line
 * still carries `applied yes/no` so the day a pass earns its place the format does not change.
 */

/** 20 ms frames at 16 kHz — long enough for a stable RMS, short enough to see a pause. */
export const FRAME_MS = 20;
/** Silence floor for the dBFS scale: a frame of all zeros reads -96 dBFS, never -Infinity. */
const DB_FLOOR = -96;

export type AudioStats = {
  /** Length of the clip in seconds (one decimal). */
  seconds: number;
  /** The pause floor — the 10th percentile of frame RMS, in dBFS. */
  floorDbfs: number;
  /** The speech level — the 90th percentile of frame RMS, in dBFS. */
  speechDbfs: number;
  /** speech - floor, in dB: how far the words sit above the noise. */
  snrDb: number;
  /** How many frames were measured (0 = too short to say anything). */
  frames: number;
};

function dbfs(rms: number): number {
  if (!(rms > 0)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(rms / 32768));
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Measure 16-bit mono PCM: pause floor, speech level and their gap. */
export function audioStats(pcm: Buffer, sampleRate = 16000): AudioStats {
  const n = Math.floor((pcm?.length || 0) / 2);
  const frame = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
  const rms: number[] = [];
  for (let i = 0; i + frame <= n; i += frame) {
    let s = 0;
    for (let k = 0; k < frame; k++) {
      const v = pcm.readInt16LE((i + k) * 2);
      s += v * v;
    }
    rms.push(Math.sqrt(s / frame));
  }
  const seconds = round1(n / sampleRate);
  if (!rms.length) return { seconds, floorDbfs: DB_FLOOR, speechDbfs: DB_FLOOR, snrDb: 0, frames: 0 };
  rms.sort((a, b) => a - b);
  const at = (q: number) => rms[Math.min(rms.length - 1, Math.floor(rms.length * q))];
  const floorDbfs = round1(dbfs(at(0.1)));
  const speechDbfs = round1(dbfs(at(0.9)));
  return { seconds, floorDbfs, speechDbfs, snrDb: round1(speechDbfs - floorDbfs), frames: rms.length };
}

/** Words in a transcript — whitespace-separated tokens; an empty transcript is 0. */
export function wordCount(text: string): number {
  const t = (text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/** The device front-end tag from the upload (`fe=ns1agc`), or null. Only a short plain token is
 *  ever accepted — it lands in a filename and a log line. */
export function feTag(raw: unknown): string | null {
  const s = String(raw ?? '').trim().toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(s) ? s : null;
}

/** The pendant's front-end has already done stationary noise + level (mic-frontend-plan §6): the
 *  server must not normalise a second time — two gain stages pump. */
export function deviceHandledLevel(fe: string | null | undefined): boolean {
  return fe === 'ns1agc';
}

export type DenoiseLineInput = {
  before: AudioStats;
  /** Stats of what actually reached the transcriber (same as `before` when nothing was applied). */
  after?: AudioStats;
  applied: boolean;
  /** Plain words for the yes/no — why it ran, or why it did not. */
  reason: string;
  fe?: string | null;
  words: number;
};

/** The reason printed on every turn while the pass is parked (BEA-1622). */
export const PASS_OFF_REASON = 'server pass off: measured no gain, BEA-1622';

/**
 * One line per turn, the shape the issue asked for:
 * `[emo] denoise: floor -41.0 dBFS → -41.0, applied no (…), speech -25.0 dBFS, snr 16 dB, 22.4s, fe none, words 31`
 */
export function denoiseLine(i: DenoiseLineInput): string {
  const after = i.after || i.before;
  return `[emo] denoise: floor ${i.before.floorDbfs.toFixed(1)} dBFS → ${after.floorDbfs.toFixed(1)}, applied ${i.applied ? 'yes' : 'no'} (${i.reason}), ` +
    `speech ${i.before.speechDbfs.toFixed(1)} dBFS, snr ${Math.round(i.before.snrDb)} dB, ${i.before.seconds.toFixed(1)}s, fe ${i.fe || 'none'}, words ${i.words}`;
}
