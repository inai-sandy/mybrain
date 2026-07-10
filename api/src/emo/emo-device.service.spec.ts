import { EmoDeviceService, wavWrap, resample24to16, decodeOpusStream, normalizePcm } from './emo-device.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpusScript = require('opusscript');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.EMO_DEVICE_AUDIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'emo-audio-'));

describe('EmoDeviceService (BEA-926)', () => {
  const voice: any = {
    transcribe: jest.fn(async () => 'call the supplier tomorrow'),
    transcribeWith: jest.fn(async () => 'call the supplier tomorrow'),
    ttsPcm: jest.fn(async () => {
      // 24 samples of a ramp at "24kHz" -> expect 16 samples out
      const b = Buffer.alloc(24 * 2);
      for (let i = 0; i < 24; i++) b.writeInt16LE(i * 100, i * 2);
      return b;
    }),
  };
  const router: any = { route: jest.fn(async () => ({ cards: [{ id: 'c1', lane: 'reminder', summary: 'Call the supplier' }] })) };
  const ask: any = { ask: jest.fn(async () => ({ mode: 'answer', summary: 'Short answer.', cardId: 'a1' })) };
  const talk: any = { talk: jest.fn(async () => ({ conversationId: 't1', reply: 'Sure thing.', sources: [], usedWeb: false })) };
  const svc = new EmoDeviceService(voice, router, ask, talk);
  const pcm = Buffer.alloc(3200); // 100ms of 16k mono silence

  beforeEach(() => jest.clearAllMocks());

  it('wavWrap writes a valid 16k mono header', () => {
    const w = wavWrap(Buffer.alloc(1000), 16000);
    expect(w.length).toBe(1044);
    expect(w.toString('ascii', 0, 4)).toBe('RIFF');
    expect(w.readUInt32LE(24)).toBe(16000); // sample rate
    expect(w.readUInt16LE(22)).toBe(1); // mono
    expect(w.readUInt16LE(34)).toBe(16); // bits
    expect(w.readUInt32LE(40)).toBe(1000); // data size
  });

  it('resample24to16 keeps 2/3 of the samples and interpolates linearly', () => {
    const b = Buffer.alloc(6 * 2);
    [0, 300, 600, 900, 1200, 1500].forEach((v, i) => b.writeInt16LE(v, i * 2));
    const out = resample24to16(b);
    expect(out.length / 2).toBe(4);
    expect(out.readInt16LE(0)).toBe(0);
    expect(out.readInt16LE(2)).toBe(450); // 1.5 -> midway between 300 and 600
    expect(out.readInt16LE(4)).toBe(900); // 3.0 -> exact sample
  });

  it('rejects empty audio', async () => {
    await expect(svc.turn(Buffer.alloc(0))).rejects.toThrow();
  });

  it('capture mode routes the transcript and answers with a confirmation', async () => {
    const r = await svc.turn(pcm, { mode: 'capture' });
    expect(voice.transcribeWith).toHaveBeenCalledWith('deepgram', expect.any(Buffer), 'device-turn.wav', 'audio/wav');
    expect(router.route).toHaveBeenCalledWith('call the supplier tomorrow', { source: 'emo-device', lane: undefined, audioPath: expect.stringMatching(/^turn-.*\.wav$/) });
    expect(r.ok).toBe(true);
    expect(r.say).toContain('Got it');
    expect(r.cardId).toBe('c1');
    expect(r.lane).toBeDefined();
  });

  it('story mode forces the story lane', async () => {
    await svc.turn(pcm, { mode: 'story' });
    expect(router.route).toHaveBeenCalledWith(expect.any(String), { source: 'emo-device', lane: 'story', audioPath: expect.any(String) });
  });

  it('keeps the recording on disk and reads it back safely', async () => {
    await svc.turn(pcm, { mode: 'capture' });
    const dir = process.env.EMO_DEVICE_AUDIO_DIR!;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
    expect(files.length).toBeGreaterThan(0);
    const buf = svc.readAudio(files[0]);
    expect(buf).not.toBeNull();
    expect(buf!.toString('ascii', 0, 4)).toBe('RIFF');
    expect(svc.readAudio('../../etc/passwd')).toBeNull(); // traversal-safe
  });

  it('unknown mode falls back to capture', async () => {
    const r = await svc.turn(pcm, { mode: 'bogus' });
    expect(r.mode).toBe('capture');
  });

  it('ask mode returns the summary as the spoken reply', async () => {
    const r = await svc.turn(pcm, { mode: 'ask' });
    expect(ask.ask).toHaveBeenCalledWith({ question: 'call the supplier tomorrow', web: 'auto' });
    expect(r.say).toBe('Short answer.');
    expect(r.cardId).toBe('a1');
  });

  it('talk mode carries the conversation id both ways', async () => {
    const r = await svc.turn(pcm, { mode: 'talk', conversationId: 'prev' });
    expect(talk.talk).toHaveBeenCalledWith({ message: expect.any(String), conversationId: 'prev', web: 'auto' });
    expect(r.conversationId).toBe('t1');
    expect(r.say).toBe('Sure thing.');
  });

  it('empty transcription returns a friendly retry, not a crash', async () => {
    voice.transcribeWith.mockResolvedValueOnce('   ');
    const r = await svc.turn(pcm, { mode: 'capture' });
    expect(r.ok).toBe(false);
    expect(r.say).toContain('Try again');
  });

  it('decodes a length-prefixed opus stream back to PCM (roundtrip)', () => {
    const opus = new OpusScript(16000, 1, OpusScript.Application.VOIP);
    const frames: Buffer[] = [];
    for (let f = 0; f < 5; f++) {
      const pcmIn = Buffer.alloc(960 * 2);
      for (let i = 0; i < 960; i++) pcmIn.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * (f * 960 + i)) / 16000)), i * 2);
      const pkt = Buffer.from(opus.encode(pcmIn, 960));
      const head = Buffer.alloc(2);
      head.writeUInt16LE(pkt.length, 0);
      frames.push(head, pkt);
    }
    const pcm = decodeOpusStream(Buffer.concat(frames));
    expect(pcm.length).toBe(5 * 960 * 2);   // 5 frames x 60ms
  });

  it('normalizePcm boosts quiet audio without clipping', () => {
    const quiet = Buffer.alloc(200);
    for (let i = 0; i < 100; i++) quiet.writeInt16LE(i % 2 ? 1000 : -1000, i * 2);
    const loud = normalizePcm(quiet);
    const v = Math.abs(loud.readInt16LE(2));
    expect(v).toBeGreaterThan(6000);        // gained
    expect(v).toBeLessThanOrEqual(8000);    // capped at 8x
  });

  it('ttsWav16k resamples the PCM and wraps it as a 16k WAV', async () => {
    const wav = await svc.ttsWav16k('hello');
    expect(wav).not.toBeNull();
    expect(wav!.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav!.readUInt32LE(24)).toBe(16000);
    expect(wav!.readUInt32LE(40)).toBe(16 * 2); // 24 samples in -> 16 samples out
  });
});
