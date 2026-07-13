import { RecordingsService, scanOpusSeconds, sliceOpusPackets } from './recordings.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The spec's fake packets aren't real opus — stub the codec layer, keep the math real.
jest.mock('../emo/emo-device.service', () => ({
  decodeOpusStream: jest.fn((b: Buffer) => Buffer.alloc(Math.max(2, b.length) * 10)),
  normalizePcm: jest.fn((b: Buffer) => b),
  wavWrap: jest.fn((b: Buffer) => b),
}));

/** Build a fake length-prefixed opus stream of n packets (payload = 10 bytes each). */
function fakeStream(n: number): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const h = Buffer.alloc(2);
    h.writeUInt16LE(10, 0);
    parts.push(h, Buffer.alloc(10, i % 256));
  }
  return Buffer.concat(parts);
}

describe('opus stream math', () => {
  it('counts packets and seconds exactly (60ms per packet)', () => {
    const s = scanOpusSeconds(fakeStream(1000)); // 1000 * 60ms = 60s
    expect(s.packets).toBe(1000);
    expect(s.seconds).toBe(60);
  });

  it('slices a packet range that stays parseable', () => {
    const sliced = sliceOpusPackets(fakeStream(100), 10, 20);
    const s = scanOpusSeconds(sliced);
    expect(s.packets).toBe(10);
  });

  it('survives a truncated tail without crashing', () => {
    const cut = fakeStream(5).subarray(0, 30); // mid-packet cut
    expect(scanOpusSeconds(cut).packets).toBeLessThanOrEqual(5);
  });
});

describe('RecordingsService', () => {
  let tmp: string;
  let svc: RecordingsService;
  let db: any;
  let voice: any;
  const recs = new Map<string, any>();
  const chunks: any[] = [];
  const marks = new Map<string, any>();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
    process.env.RECORDINGS_DIR = tmp;
    recs.clear(); chunks.length = 0; marks.clear();
    let n = 0;
    db = {
      recording: {
        create: jest.fn(async ({ data }: any) => { const r = { id: `r${++n}`, seconds: 0, bytes: 0, status: 'recording', title: null, ...data }; recs.set(r.id, r); return r; }),
        findUnique: jest.fn(async ({ where, include }: any) => {
          const r = recs.get(where.id); if (!r) return null;
          return include?.chunks ? { ...r, chunks: chunks.filter(c => c.recordingId === r.id) } : { ...r };
        }),
        update: jest.fn(async ({ where, data }: any) => { Object.assign(recs.get(where.id), data); return recs.get(where.id); }),
        count: jest.fn(async () => recs.size),
        findMany: jest.fn(async () => [...recs.values()]),
        delete: jest.fn(async ({ where }: any) => recs.delete(where.id)),
      },
      recordingChunk: {
        upsert: jest.fn(async ({ create }: any) => { chunks.push(create); return create; }),
        findMany: jest.fn(async ({ where }: any) => chunks.filter(c => c.recordingId === where.recordingId).sort((a, b) => a.seq - b.seq)),
        findUnique: jest.fn(async ({ where }: any) => chunks.find(c => c.recordingId === where.recordingId_seq.recordingId && c.seq === where.recordingId_seq.seq) || null),
      },
      recordingMark: {
        create: jest.fn(async ({ data }: any) => { const m = { id: `m${++n}`, status: 'pending', transcript: null, cardId: null, ...data }; marks.set(m.id, m); return m; }),
        findMany: jest.fn(async ({ where }: any) => [...marks.values()].filter(m => m.recordingId === where.recordingId && (!where.status || m.status === where.status))),
        findUnique: jest.fn(async ({ where }: any) => marks.get(where.id) || null),
        update: jest.fn(async ({ where, data }: any) => { Object.assign(marks.get(where.id), data); return marks.get(where.id); }),
      },
      emoCard: { create: jest.fn(async ({ data }: any) => ({ id: 'card1', ...data })) },
    };
    voice = { transcribeWith: jest.fn(async () => 'the client agreed to five hundred pieces') };
    svc = new RecordingsService(db, voice);
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('start trusts a sane device clock and stamps the IST day', async () => {
    const t = Date.now() - 60_000;
    await svc.start(t);
    const r = [...recs.values()][0];
    expect(Math.abs(r.startedAt.getTime() - t)).toBeLessThan(1000);
    expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rejects a device clock more than 10 minutes off', async () => {
    await svc.start(Date.now() - 3 * 3600_000);
    const r = [...recs.values()][0];
    expect(Math.abs(r.startedAt.getTime() - Date.now())).toBeLessThan(5000);
  });

  it('chunks accumulate startSec and total seconds', async () => {
    const { id } = await svc.start(Date.now());
    await svc.addChunk(id, 0, fakeStream(1000)); // 60s
    await svc.addChunk(id, 1, fakeStream(500));  // 30s
    expect(recs.get(id).seconds).toBe(90);
    expect(chunks[1].startSec).toBe(60);
  });

  it('a mark waits for audio, then transcribes only its window', async () => {
    const { id } = await svc.start(Date.now());
    await svc.addChunk(id, 0, fakeStream(1000)); // 60s available
    await svc.addMark(id, 120, 120); // needs up to 120s — not covered yet
    expect([...marks.values()][0].status).toBe('pending');
    await svc.addChunk(id, 1, fakeStream(1000)); // now 120s
    await svc.processPendingMarks(id);
    const m = [...marks.values()][0];
    expect(m.status).toBe('done');
    expect(m.transcript).toContain('five hundred');
    expect(voice.transcribeWith).toHaveBeenCalled();
  });

  it('wallTime = session start + offset (the spoken moment, not the transcribed moment)', async () => {
    const t = Date.now();
    const { id } = await svc.start(t);
    await svc.addChunk(id, 0, fakeStream(2000));
    await svc.addMark(id, 100, 60);
    const m = [...marks.values()][0];
    expect(Math.abs(m.wallTime.getTime() - (t + 100_000))).toBeLessThan(1500);
  });

  it('promote turns a transcribed mark into an EMO meeting card', async () => {
    const t = Date.now();
    const { id } = await svc.start(t);
    await svc.addChunk(id, 0, fakeStream(2000));
    const { id: markId } = await svc.addMark(id, 60, 60);
    await svc.processPendingMarks(id);
    // promote needs the mark joined with its recording
    db.recordingMark.findUnique = jest.fn(async ({ where }: any) => ({ ...marks.get(where.id), recording: recs.get(id) }));
    const out = await svc.promote(markId);
    expect(out.cardId).toBe('card1');
    const created = db.emoCard.create.mock.calls[0][0].data;
    expect(created.lane).toBe('meeting');
    expect(created.source).toBe('recording');
  });

  it('end sets a human span title and finishes the session', async () => {
    const { id } = await svc.start(Date.now());
    await svc.addChunk(id, 0, fakeStream(3000)); // 3 minutes
    const out = await svc.end(id);
    expect(out.title).toMatch(/, \d{2}:\d{2}–\d{2}:\d{2}$/);
    expect(recs.get(id).status).toBe('done');
  });
});
