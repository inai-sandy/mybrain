import { EmoDeviceService, wavWrap, resample24to16, decodeOpusStream, decodeImaAdpcm, ADPCM_BLOCK, normalizePcm, clampForDevice, DEVICE_BODY_BUDGET } from './emo-device.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OpusScript = require('opusscript');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

process.env.EMO_DEVICE_AUDIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'emo-audio-'));
process.env.EMO_FASTACK = '0'; // these suites exercise the synchronous path; the fast-ack suite flips it on

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
      { id: 'a2', name: 'ESP32 weekly top posts', color: '#34d399', areaId: null },
      { id: 'a1', name: 'AI News Daily', color: null, areaId: null },
      { id: 'a3', name: 'Build a manually run agent that, each time you start it, …', color: null, areaId: 'ar-esp' },
      { id: 'a4', name: 'Meshtastic Practicality Report', color: null, areaId: 'ar-research' },
      { id: 'a5', name: 'Indian Apartment EV Charging', color: null, areaId: 'ar-research' },
    ]) },
    agentArea: { findMany: jest.fn(async () => [
      { id: 'ar-esp', name: 'top ESP32 posts from last week', color: '#fbbf24' },
      { id: 'ar-research', name: 'Research Agent', color: '#2563EB' },
    ]) },
    emoDeviceReminder: {
      findMany: jest.fn(async () => [{ id: 'dr1', text: 'call the vendor', dueAt: new Date(1760000000000), status: 'active' }]),
      update: jest.fn(async () => ({})),
    },
    emoCard: { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
  };
  const notes: any = { create: jest.fn(async () => ({ id: 'n1' })) };
  const svc = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, { setDone: async () => undefined } as any, { create: async () => ({}) } as any);
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
    prisma.emoCard = { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) } as any;
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
    const s = new EmoDeviceService(v, r, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, { setDone: async () => undefined } as any, { create: async () => ({}) } as any);
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
    const s = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, tasks, { create: async () => ({}) } as any);
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
    const s = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide: async () => ({ ok: true }) } as any, tasks, { create: async () => ({}) } as any);
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
    const s2 = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide } as any, { setDone } as any, { create: async () => ({}) } as any);
    await s2.ackDeviceReminder('claim:k1', 'done');
    expect(decide).toHaveBeenCalledWith('k1', true);
    expect(setDone).toHaveBeenCalledWith('t1', true);
  });

  it('"reject" from the device sends it back instead of closing it', async () => {
    const decide = jest.fn(async () => ({ ok: true, taskId: 't1', confirmed: false }));
    const setDone = jest.fn(async () => undefined);
    const s2 = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide } as any, { setDone } as any, { create: async () => ({}) } as any);
    await s2.ackDeviceReminder('claim:k1', 'reject');
    expect(decide).toHaveBeenCalledWith('k1', false);
    expect(setDone).toHaveBeenCalledWith('t1', false);
  });

  it('an auto-"missed" from old firmware NEVER decides a claim — it is a timeout, not a human', async () => {
    const decide = jest.fn(async () => ({ ok: true, taskId: 't1', confirmed: false }));
    const s2 = new EmoDeviceService(voice, router, ask, talk, prisma, notes, { decide } as any, { setDone: jest.fn() } as any, { create: async () => ({}) } as any);
    const r = await s2.ackDeviceReminder('claim:k1', 'missed');
    expect(r.ok).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });

  it('a plain reminder still acks exactly as before', async () => {
    await svc.ackDeviceReminder('dr1', 'missed');
    expect(prisma.emoDeviceReminder.update).toHaveBeenCalledWith({ where: { id: 'dr1' }, data: { status: 'missed' } });
  });

  it('lists every agent with a task, named like the app: card name, or the job name when the card holds several (BEA-1590/1591/1592)', async () => {
    const rows = await svc.listAgentsForDevice();
    expect(prisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { AND: [{ prompt: { not: null } }, { prompt: { not: '' } }] } }));
    expect(rows).toEqual([
      { id: 'a1', name: 'AI News Daily', color: null },
      { id: 'a2', name: 'ESP32 weekly top posts', color: '#34d399' },
      { id: 'a5', name: 'Indian Apartment EV Charging', color: '#2563EB' },   // shared card: job name, card colour
      { id: 'a4', name: 'Meshtastic Practicality Report', color: '#2563EB' },
      { id: 'a3', name: 'top ESP32 posts from last week', color: '#fbbf24' }, // its own card: the card's name
    ]);
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(['color', 'id', 'name']);
  });
});


describe('fast-ack for deferred lanes (BEA-1593)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emo-pending-'));
  const voice: any = {
    transcribeWith: jest.fn(async () => 'remember to call the supplier'),
    transcribeMeeting: jest.fn(async () => 'Speaker 1: hello'),
    ttsPcm: jest.fn(async () => Buffer.alloc(48)),
  };
  const router: any = { route: jest.fn(async () => ({ cards: [{ id: 'c1', lane: 'note', summary: 'Call the supplier' }] })) };
  const ask: any = { ask: jest.fn(async () => ({ mode: 'answer', summary: 'The answer.', cardId: 'a1' })) };
  const talk: any = { talk: jest.fn(async () => ({ conversationId: 't1', reply: 'Hi.' })) };
  const cards: any = { create: jest.fn(async () => ({ id: 'f1' })) };
  const mk = (v: any = voice) =>
    new EmoDeviceService(v, router, ask, talk, {} as any, { create: jest.fn() } as any,
      { decide: async () => ({ ok: true }) } as any, { setDone: async () => undefined } as any, cards);
  const pcm = Buffer.alloc(3200);
  const pending = () => fs.readdirSync(tmp).filter((f) => /^pend-.*\.wav$/.test(f));
  const settle = () => new Promise((r) => setTimeout(r, 120));

  beforeAll(() => { process.env.EMO_FASTACK = '1'; process.env.EMO_PENDING_DIR = tmp; });
  afterAll(() => { process.env.EMO_FASTACK = '0'; delete process.env.EMO_PENDING_DIR; });
  beforeEach(() => { jest.clearAllMocks(); for (const f of pending()) fs.unlinkSync(path.join(tmp, f)); });

  it('confirms instantly, holds the audio on disk, then routes in the background', async () => {
    const s = mk();
    const r = await s.turn(pcm, { mode: 'capture' });
    expect(r.ok).toBe(true);
    expect(r.reply).toMatch(/Saved/);
    await settle();
    expect(voice.transcribeWith).toHaveBeenCalled();
    expect(router.route).toHaveBeenCalledWith('remember to call the supplier', expect.objectContaining({ source: 'emo-device' }));
    expect(pending()).toHaveLength(0); // processed and cleaned up
  });

  it('ask stays synchronous — the device needs the answer in the reply', async () => {
    const s = mk();
    const r = await s.turn(pcm, { mode: 'ask' });
    expect(ask.ask).toHaveBeenCalled();
    expect(r.reply).toBe('The answer.');
    expect(pending()).toHaveLength(0); // never went through the pending store
  });

  it('keeps the audio and surfaces a card when transcription fails for good', async () => {
    const failing: any = { ...voice, transcribeWith: jest.fn(async () => { throw new Error('stt down'); }) };
    const s = mk(failing);
    s.retryDelayMs = 1;
    const r = await s.turn(pcm, { mode: 'note' });
    expect(r.ok).toBe(true);
    await settle();
    expect(failing.transcribeWith).toHaveBeenCalledTimes(3);
    const failed = fs.readdirSync(path.join(tmp, 'failed'));
    expect(failed.length).toBeGreaterThan(0);
    expect(cards.create).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('Recording kept') }));
    for (const f of failed) fs.unlinkSync(path.join(tmp, 'failed', f));
  });

  it('startup sweep recovers recordings a restart stranded', async () => {
    fs.writeFileSync(path.join(tmp, 'pend-1-abcd1234-capture.wav'), wavWrap(pcm, 16000));
    fs.writeFileSync(path.join(tmp, 'pend-9-dead-note.wav.part'), Buffer.alloc(8)); // stale half-write: swept away
    const s = mk();
    s.onModuleInit();
    await settle();
    expect(voice.transcribeWith).toHaveBeenCalled();
    expect(router.route).toHaveBeenCalled();
    expect(pending()).toHaveLength(0);
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.part'))).toHaveLength(0);
  });
});


describe('INPUT inbox: agent questions + answers (BEA-1594)', () => {
  const voice: any = {
    transcribeWith: jest.fn(async () => 'go with the second vendor'),
    transcribeMeeting: jest.fn(async () => ''),
    ttsPcm: jest.fn(async () => Buffer.alloc(48)),
  };
  const router: any = { route: jest.fn(async () => ({ cards: [] })) };
  const cards: any = { create: jest.fn(async () => ({})), answer: jest.fn(async () => ({ ok: true })) };
  const prisma: any = {
    emoDeviceReminder: { findMany: jest.fn(async () => []), update: jest.fn(async () => ({})) },
    taskClaim: { findMany: jest.fn(async () => []) },
    emoCard: { findMany: jest.fn(async () => [
      { id: 'q1', summary: 'Research Agent', title: null, needsQuestion: 'Which vendor should I compare first?',
        needsOptions: JSON.stringify(['Vendor A', 'Vendor B']), createdAt: new Date(1760000002000) },
    ]) },
  };
  const svc = new EmoDeviceService(voice, router, {} as any, {} as any, prisma,
    { create: jest.fn() } as any, { decide: async () => ({ ok: true }) } as any,
    { setDone: async () => undefined } as any, cards);
  const pcm = Buffer.alloc(3200);

  beforeEach(() => jest.clearAllMocks());

  it('needs-you cards join the feed as questions, with options, and count as needsYou', async () => {
    const r = await svc.listDeviceReminders();
    const q = r.reminders.find((x: any) => x.kind === 'question')! as any;
    expect(q.id).toBe('card:q1');
    expect(q.text).toBe('Which vendor should I compare first?');
    expect(q.options).toEqual(['Vendor A', 'Vendor B']);
    expect(r.needsYou).toBe(1);
  });

  it('acking a card: id records the payload as the answer', async () => {
    const r = await svc.ackDeviceReminder('card:q1', 'Vendor B');
    expect(r.ok).toBe(true);
    expect(cards.answer).toHaveBeenCalledWith('q1', 'Vendor B');
  });

  it('a timed-out ring never answers a question for the owner', async () => {
    const r = await svc.ackDeviceReminder('card:q1', 'missed');
    expect(r.ok).toBe(true);
    expect(cards.answer).not.toHaveBeenCalled();
  });

  it('turn?answerTo speaks the answer through the fast-ack pipeline', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emo-ans-'));
    process.env.EMO_FASTACK = '1'; process.env.EMO_PENDING_DIR = tmp;
    try {
      const r = await svc.turn(pcm, { mode: 'note', answerTo: 'card:1234abcd-0000-0000-0000-00000000beef' });
      expect(r.ok).toBe(true);
      expect(fs.readdirSync(tmp).some((f) => f.includes('-ans_1234abcd'))).toBe(true);
      await new Promise((res) => setTimeout(res, 120));
      expect(cards.answer).toHaveBeenCalledWith('1234abcd-0000-0000-0000-00000000beef', 'go with the second vendor');
      expect(router.route).not.toHaveBeenCalled();   // the words went to the card, not the router
    } finally {
      process.env.EMO_FASTACK = '0'; delete process.env.EMO_PENDING_DIR;
    }
  });

  it('turn?answerTo also works on the synchronous path', async () => {
    const r = await svc.turn(pcm, { mode: 'note', answerTo: 'card:feed1234-0000-0000-0000-000000000001' });
    expect(cards.answer).toHaveBeenCalledWith('feed1234-0000-0000-0000-000000000001', 'go with the second vendor');
    expect(r.reply).toBe('Answered.');
  });
});


describe('IMA ADPCM decode (BEA-1595)', () => {
  // Reference encoder — the mirror of the firmware's. Same tables as the decoder.
  const STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
  const IDX = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
  function encode(pcm: Buffer, blockSize = ADPCM_BLOCK): Buffer {
    const n = pcm.length >> 1;
    const spb = (blockSize - 4) * 2 + 1;
    const blocks = Math.ceil(n / spb);
    const out = Buffer.alloc(blocks * blockSize);
    let s = 0, pred = 0, idx = 0;
    for (let b = 0; b < blocks; b++) {
      const base = b * blockSize;
      pred = s < n ? pcm.readInt16LE(s * 2) : pred;
      out.writeInt16LE(pred, base); out[base + 2] = idx; out[base + 3] = 0;
      s++;                                       // first sample rides the header verbatim
      for (let i = base + 4; i < base + blockSize; i++) {
        let byte = 0;
        for (let half = 0; half < 2; half++) {
          let nib = 0;
          if (s < n) {
            const step = STEP[idx];
            let diff = pcm.readInt16LE(s * 2) - pred;
            if (diff < 0) { nib = 8; diff = -diff; }
            if (diff >= step) { nib |= 4; diff -= step; }
            if (diff >= step >> 1) { nib |= 2; diff -= step >> 1; }
            if (diff >= step >> 2) nib |= 1;
            let d = step >> 3;
            if (nib & 1) d += step >> 2;
            if (nib & 2) d += step >> 1;
            if (nib & 4) d += step;
            pred += (nib & 8) ? -d : d;
            if (pred > 32767) pred = 32767; else if (pred < -32768) pred = -32768;
            idx += IDX[nib & 7];
            if (idx < 0) idx = 0; else if (idx > 88) idx = 88;
            s++;
          }
          byte |= half ? (nib << 4) : nib;
        }
        out[i] = byte;
      }
    }
    return out;
  }

  it('round-trips a sine wave at 4:1 with decent fidelity', () => {
    const n = 505 * 3;                                   // exactly 3 blocks
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin((i / 16000) * 2 * Math.PI * 440)), i * 2);
    const enc = encode(pcm);
    expect(enc.length).toBe(3 * ADPCM_BLOCK);            // truly ~4:1
    const dec = decodeImaAdpcm(enc);
    expect(dec.length).toBe(pcm.length);
    let sig = 0, err = 0;
    for (let i = 0; i < n; i++) {
      const a = pcm.readInt16LE(i * 2), b = dec.readInt16LE(i * 2);
      sig += a * a; err += (a - b) * (a - b);
    }
    const snr = 10 * Math.log10(sig / Math.max(err, 1));
    expect(snr).toBeGreaterThan(20);                     // speech-quality territory
  });

  it('a truncated tail block decodes as far as it goes, never throws', () => {
    const pcm = Buffer.alloc(505 * 2 * 2);
    const enc = encode(pcm).subarray(0, ADPCM_BLOCK + 40);   // second block cut mid-way
    const dec = decodeImaAdpcm(enc);
    expect(dec.length).toBeGreaterThan(505 * 2);
    expect(() => decodeImaAdpcm(Buffer.from([1, 2, 3]))).not.toThrow();
    expect(decodeImaAdpcm(Buffer.alloc(0)).length).toBe(0);
  });
});

describe('the audio ruler on every device turn (BEA-1622)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emo-ruler-'));
  const voice: any = {
    transcribeWith: jest.fn(async () => 'call the supplier tomorrow'),
    transcribeMeeting: jest.fn(async () => 'Speaker 1: hello'),
    ttsPcm: jest.fn(async () => Buffer.alloc(48)),
  };
  const router: any = { route: jest.fn(async () => ({ cards: [{ id: 'c1', lane: 'note', summary: 'Call the supplier' }] })) };
  const cards: any = { create: jest.fn(async () => ({ id: 'f1' })) };
  const mk = () =>
    new EmoDeviceService(voice, router, { ask: jest.fn(async () => ({ mode: 'answer', summary: 'Ok.' })) } as any, { talk: jest.fn() } as any, {} as any, { create: jest.fn() } as any,
      { decide: async () => ({ ok: true }) } as any, { setDone: async () => undefined } as any, cards);
  // quiet 100 ms ramp: the normaliser WOULD boost this 8x — so "not boosted" is provable
  const quiet = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) quiet.writeInt16LE((i % 200) - 100, i * 2);
  const settle = () => new Promise((r) => setTimeout(r, 120));
  let logs: string[] = [];
  let logSpy: jest.SpyInstance;

  beforeEach(() => { jest.clearAllMocks(); logs = []; logSpy = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); }); });
  afterEach(() => logSpy.mockRestore());
  afterAll(() => { process.env.EMO_FASTACK = '0'; delete process.env.EMO_PENDING_DIR; });

  const sentData = () => (voice.transcribeWith.mock.calls[0][1] as Buffer).subarray(44);

  it('prints one denoise line per turn with floor, snr, tag and the word count — the pass is off', async () => {
    process.env.EMO_FASTACK = '0';
    const r = await mk().turn(quiet, { mode: 'ask', fe: 'ns1agc' } as any);
    expect(r.heard).toBe('call the supplier tomorrow');
    const line = logs.find((l) => l.startsWith('[emo] denoise:'));
    expect(line).toMatch(/^\[emo\] denoise: floor -\d+\.\d dBFS → -\d+\.\d, applied no \(server pass off: measured no gain, BEA-1622\), speech -\d+\.\d dBFS, snr \d+ dB, 0\.1s, fe ns1agc, words 4$/);
  });

  it('fe=ns1agc means the device set the level: the transcriber gets the bytes as they came', async () => {
    process.env.EMO_FASTACK = '0';
    await mk().turn(quiet, { mode: 'ask', fe: 'ns1agc' } as any);
    expect(sentData().equals(quiet)).toBe(true);
  });

  it('an untagged take is normalised exactly as before', async () => {
    process.env.EMO_FASTACK = '0';
    await mk().turn(quiet, { mode: 'ask' });
    expect(sentData().equals(normalizePcm(quiet))).toBe(true);
    expect(sentData().equals(quiet)).toBe(false);
    expect(logs.find((l) => l.startsWith('[emo] denoise:'))).toMatch(/fe none, words 4$/);
  });

  it('a junk tag is ignored, never trusted into a filename or a line', async () => {
    process.env.EMO_FASTACK = '0';
    await mk().turn(quiet, { mode: 'ask', fe: '../x' } as any);
    expect(sentData().equals(normalizePcm(quiet))).toBe(true);
    expect(logs.find((l) => l.startsWith('[emo] denoise:'))).toMatch(/fe none/);
  });

  it('the tag rides the pending filename through fast-ack and a restart sweep, and the line still prints', async () => {
    process.env.EMO_FASTACK = '1';
    process.env.EMO_PENDING_DIR = tmp;
    const s = mk();
    const r = await s.turn(quiet, { mode: 'note', fe: 'ns1agc' } as any);
    expect(r.reply).toMatch(/Saved/);
    await settle();
    expect(sentData().equals(quiet)).toBe(true);                       // no second gain stage
    expect(logs.find((l) => l.startsWith('[emo] denoise:'))).toMatch(/fe ns1agc, words 4$/);
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.wav'))).toHaveLength(0);
    // a tagged file a restart finds: the sweep reads the tag back out of the name
    jest.clearAllMocks(); logs = [];
    fs.writeFileSync(path.join(tmp, 'pend-1-abcd1234-note-fe_ns1agc.wav'), wavWrap(quiet, 16000));
    fs.writeFileSync(path.join(tmp, 'pend-2-abcd1234-note-capped-fe_ns1agc-ans_0123abcd.wav'), wavWrap(quiet, 16000));
    s.onModuleInit();
    await settle();
    expect(voice.transcribeWith).toHaveBeenCalledTimes(2);
    expect(logs.filter((l) => /fe ns1agc/.test(l))).toHaveLength(2);
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.wav'))).toHaveLength(0);
  });
});
