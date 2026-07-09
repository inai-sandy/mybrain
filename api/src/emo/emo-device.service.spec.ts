import { EmoDeviceService, wavWrap, resample24to16 } from './emo-device.service';

describe('EmoDeviceService (BEA-926)', () => {
  const voice: any = {
    transcribe: jest.fn(async () => 'call the supplier tomorrow'),
    ttsPcm: jest.fn(async () => {
      // 24 samples of a ramp at "24kHz" -> expect 16 samples out
      const b = Buffer.alloc(24 * 2);
      for (let i = 0; i < 24; i++) b.writeInt16LE(i * 100, i * 2);
      return b;
    }),
  };
  const router: any = { route: jest.fn(async () => ({ cards: [{ id: 'c1', summary: 'Call the supplier' }] })) };
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
    expect(voice.transcribe).toHaveBeenCalled();
    expect(router.route).toHaveBeenCalledWith('call the supplier tomorrow', { source: 'emo-device', lane: undefined });
    expect(r.ok).toBe(true);
    expect(r.say).toContain('Got it');
    expect(r.cardId).toBe('c1');
  });

  it('story mode forces the story lane', async () => {
    await svc.turn(pcm, { mode: 'story' });
    expect(router.route).toHaveBeenCalledWith(expect.any(String), { source: 'emo-device', lane: 'story' });
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
    voice.transcribe.mockResolvedValueOnce('   ');
    const r = await svc.turn(pcm, { mode: 'capture' });
    expect(r.ok).toBe(false);
    expect(r.say).toContain('Try again');
  });

  it('ttsWav16k resamples the PCM and wraps it as a 16k WAV', async () => {
    const wav = await svc.ttsWav16k('hello');
    expect(wav).not.toBeNull();
    expect(wav!.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav!.readUInt32LE(24)).toBe(16000);
    expect(wav!.readUInt32LE(40)).toBe(16 * 2); // 24 samples in -> 16 samples out
  });
});
