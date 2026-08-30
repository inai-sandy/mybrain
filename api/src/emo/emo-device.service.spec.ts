import { EmoDeviceService, wavWrap, resample24to16, decodeOpusStream, normalizePcm, clampForDevice, DEVICE_BODY_BUDGET } from './emo-device.service';
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
    transcribeMeeting: jest.fn(async () => 'Speaker 1: shall we ship friday?\nSpeaker 2: yes, agreed.'),
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
  const prisma: any = {
    // Claims waiting on the owner also ride this feed now (BEA-1035). None in this fixture.
    taskClaim: { findMany: jest.fn(async () => []) },
    agent: { findMany: jest.fn(async () => [
      { id: 'a2', name: 'ESP32 weekly top posts', color: '#34d399' },
      { id: 'a1', name: 'AI News Daily', color: null },
    ]) },
    emoDeviceReminder: {
      findMany: jest.fn(async () => [{ id: 'dr1', text: 'call the vendor', dueAt: new Date(1760000000000), status: 'active' }]),
      update: jest.fn(async () => ({})),
    },
  };
  const notes: any = { create: jest.fn(async () => ({ id: 'n1' })) };
  const svc = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, { setDone: async () => undefined } as any);
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

  it('lists upcoming device reminders with epoch dueAt and acks them (BEA-944)', async () => {
    const r = await svc.listDeviceReminders();
    // `kind` is additive — old firmware ignores it and behaves exactly as before. (BEA-1035)
    expect(r.reminders).toEqual([{ id: 'dr1', text: 'call the vendor', dueAt: 1760000000000, kind: 'reminder' }]);
    await svc.ackDeviceReminder('dr1', 'done');
    expect(prisma.emoDeviceReminder.update).toHaveBeenCalledWith({ where: { id: 'dr1' }, data: { status: 'done' } });
  });

  it('note mode also creates a REAL Note (BEA-957)', async () => {
    prisma.emoCard = { update: jest.fn(async () => ({})) } as any;
    await svc.turn(pcm, { mode: 'note' });
    expect(notes.create).toHaveBeenCalledWith(expect.objectContaining({ content: expect.any(String) }));
  });

  it('rejects empty audio', async () => {
    await expect(svc.turn(Buffer.alloc(0))).rejects.toThrow();
  });

  // BEA-1139: the firmware parses the response out of a fixed 1600-byte buffer filled by ONE
  // read. An oversized body arrives truncated, fails to parse, and the device speaks an error
  // clip ("I missed that.") even though the capture landed with HTTP 201. Story and dump are
  // exempt from the 3-minute cap, so their transcripts are always long enough to trip it.
  it('a long story turn stays inside the device parse buffer', async () => {
    const longTranscript = 'today I walked to the market and thought about the vendor list. '.repeat(120); // ~7.5k chars
    const v: any = { ...voice, transcribeWith: jest.fn(async () => longTranscript) };
    const r: any = { route: jest.fn(async () => ({ cards: [{ id: 'c9', lane: 'story', summary: longTranscript }] })) };
    const s = new EmoDeviceService(v, r, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, { setDone: async () => undefined } as any);
    const out = await s.turn(pcm, { mode: 'story' });
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(DEVICE_BODY_BUDGET);
    // and it must still be a SUCCESS the device can act on, not an empty husk
    expect(out.ok).toBe(true);
    expect((out.say || '').length).toBeGreaterThan(0);
    expect((out.reply || '').length).toBeGreaterThan(0);
    expect((out.heard || '').length).toBeGreaterThan(0);
  });

  it('clampForDevice keeps short turns byte-identical', () => {
    const small: any = { ok: true, mode: 'note', heard: 'buy milk', reply: '• Buy milk', say: 'Got it. Buy milk' };
    expect(clampForDevice(small)).toEqual(small);
  });

  // Review catch: shrinking only `reply` was not enough. ask/talk put the whole unbounded answer
  // in `say`, and non-ASCII costs up to 3 bytes per character — so a long Hindi answer with a
  // SHORT reply sailed past the old character-based caps and still overflowed the device.
  it('clamps a long non-ASCII spoken answer even when the reply is tiny', () => {
    const hindi: any = {
      ok: true, mode: 'ask',
      heard: 'मुझे कल के काम के बारे में बताओ '.repeat(20),
      reply: 'ठीक है',
      say: 'आपके कल के काम में वेंडर सूची भेजना और बीओएम पूरा करना शामिल है। '.repeat(30),
    };
    const out = clampForDevice(hindi);
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(DEVICE_BODY_BUDGET);
    expect((out.say || '').length).toBeGreaterThan(0); // still says something useful
    expect(Buffer.from(out.say || '', 'utf8').toString('utf8')).toBe(out.say); // never split a character
  });

  it('clampForDevice never makes a body bigger than it was', () => {
    const justOver: any = { ok: true, mode: 'note', heard: 'x'.repeat(151), reply: 'y'.repeat(481), say: 'z'.repeat(481) };
    const before = Buffer.byteLength(JSON.stringify(justOver));
    expect(Buffer.byteLength(JSON.stringify(clampForDevice(justOver)))).toBeLessThanOrEqual(before);
  });

  it('clampForDevice survives multi-byte bullets without blowing the budget', () => {
    const bullets: any = { ok: true, mode: 'capture', heard: 'x'.repeat(4000), reply: '• ünïcødé item ✓\n'.repeat(300), say: 'y'.repeat(4000) };
    expect(Buffer.byteLength(JSON.stringify(clampForDevice(bullets)))).toBeLessThanOrEqual(DEVICE_BODY_BUDGET);
  });

  // BEA-1116: the morning brain-dump must hit the REAL tasks.dump pipeline (app/Telegram
  // parity), never the generic intent router — routing a dump scatters one morning into
  // mixed lanes instead of a day's task list.
  it('dump mode runs tasks.dump and reports the task count', async () => {
    const tasks: any = {
      setDone: async () => undefined,
      dump: jest.fn(async () => ({ dumpId: 'd1', tasks: [{ title: 'Call the supplier' }, { title: 'Send the BOM' }] })),
    };
    const s = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, tasks);
    const r = await s.turn(pcm, { mode: 'dump' });
    expect(tasks.dump).toHaveBeenCalledWith(expect.any(String), 'emo-device');
    expect(router.route).not.toHaveBeenCalled();
    expect(r.mode).toBe('dump');
    expect(r.say).toContain('2 tasks');
    expect(r.reply).toContain('Call the supplier');
  });

  it('dump mode with nothing usable passes the server question back', async () => {
    const tasks: any = {
      setDone: async () => undefined,
      dump: jest.fn(async () => ({ dumpId: 'd2', question: 'What is on your mind this morning?', tasks: [] })),
    };
    const s = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, tasks);
    const r = await s.turn(pcm, { mode: 'dump' });
    expect(r.say).toContain('What is on your mind');
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

  it('capped=1 appends the 3-minute notice to reply and say (BEA-971)', async () => {
    const r = await svc.turn(pcm, { mode: 'task', capped: true });
    expect(r.reply).toContain('3-minute limit');
    expect(r.say).toContain('three minute limit');
  });

  it('story mode forces the story lane', async () => {
    await svc.turn(pcm, { mode: 'story' });
    expect(router.route).toHaveBeenCalledWith(expect.any(String), { source: 'emo-device', lane: 'story', audioPath: expect.any(String) });
  });

  it('meeting mode transcribes with speaker labels (BEA-941)', async () => {
    await svc.turn(pcm, { mode: 'meeting' });
    expect(voice.transcribeMeeting).toHaveBeenCalled();
    expect(voice.transcribeWith).not.toHaveBeenCalled();
    expect(router.route).toHaveBeenCalledWith(expect.stringContaining('Speaker 1:'), expect.objectContaining({ lane: 'meeting' }));
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
    expect(ask.ask).toHaveBeenCalledWith({ question: 'call the supplier tomorrow', web: 'auto', direct: true, ragOnly: true }); // device never clarifies (938), RAG-only retrieval (967)
    expect(r.say).toBe('Short answer.');
    expect(r.cardId).toBe('a1');
  });

  it('talk mode carries the conversation id both ways', async () => {
    const r = await svc.turn(pcm, { mode: 'talk', conversationId: 'prev' });
    expect(talk.talk).toHaveBeenCalledWith({ message: expect.any(String), conversationId: 'prev', web: 'on', noQuestions: true }); // search-first (952)
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

  /**
   * The queue must stay backwards-compatible: a device that has never been updated keeps working.
   * (BEA-1035)
   */
  it('carries confirmations alongside reminders, and counts them', async () => {
    prisma.taskClaim.findMany = jest.fn(async () => [
      { id: 'k1', createdAt: new Date(1760000001000), contact: { name: 'Ramesh Kumar' }, task: { title: 'Send the vendor list' } },
    ]) as any;
    const r = await svc.listDeviceReminders();
    expect(r.needsYou).toBe(1);
    const confirm = r.reminders.find((x: any) => x.kind === 'confirm')!;
    expect(confirm.id).toBe('claim:k1');
    expect(confirm.text).toBe('Ramesh says done: Send the vendor list');
  });

  it('a confirmation answered on the device decides the claim', async () => {
    const decide = jest.fn(async () => ({ ok: true, taskId: 't1', confirmed: true }));
    const setDone = jest.fn(async () => undefined);
    const s2 = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide } as any, { setDone } as any);
    await s2.ackDeviceReminder('claim:k1', 'done');
    expect(decide).toHaveBeenCalledWith('k1', true);
    expect(setDone).toHaveBeenCalledWith('t1', true);
  });

  it('"reject" from the device sends it back instead of closing it', async () => {
    const decide = jest.fn(async () => ({ ok: true, taskId: 't1', confirmed: false }));
    const setDone = jest.fn(async () => undefined);
    const s2 = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide } as any, { setDone } as any);
    await s2.ackDeviceReminder('claim:k1', 'reject');
    expect(decide).toHaveBeenCalledWith('k1', false);
    expect(setDone).toHaveBeenCalledWith('t1', false);
  });

  it('an auto-"missed" from old firmware NEVER decides a claim — it is a timeout, not a human', async () => {
    const decide = jest.fn(async () => ({ ok: true, taskId: 't1', confirmed: false }));
    const s2 = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide } as any, { setDone: jest.fn() } as any);
    const r = await s2.ackDeviceReminder('claim:k1', 'missed');
    expect(r.ok).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });

  it('a plain reminder still acks exactly as before', async () => {
    await svc.ackDeviceReminder('dr1', 'missed');
    expect(prisma.emoDeviceReminder.update).toHaveBeenCalledWith({ where: { id: 'dr1' }, data: { status: 'missed' } });
  });

  it('lists every agent with a task for the device, three fields only, whatever the schedule switch says (BEA-1590, BEA-1591)', async () => {
    const rows = await svc.listAgentsForDevice();
    expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ prompt: { not: null } }, { prompt: { not: '' } }] }, select: { id: true, name: true, color: true } }));
    expect(rows).toEqual([
      { id: 'a2', name: 'ESP32 weekly top posts', color: '#34d399' },
      { id: 'a1', name: 'AI News Daily', color: null },
    ]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['color', 'id', 'name']);
  });
});
