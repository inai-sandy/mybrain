import { EmoController } from './emo.controller';

describe('EmoController (BEA-862)', () => {
  const svc: any = {
    list: jest.fn(async () => ({ cards: [], total: 0 })),
    counts: jest.fn(async () => ({ needsYou: 1, cooking: 2 })),
    get: jest.fn(async () => ({ id: 'c1' })),
    answer: jest.fn(async () => ({ ok: true })),
    update: jest.fn(async () => ({ id: 'c1', status: 'done' })),
    remove: jest.fn(async () => ({ ok: true })),
  };
  const router: any = { route: jest.fn(async () => ({ cards: [{ id: 'c1' }] })) };
  const capture: any = { capture: jest.fn(async () => ({ cards: [], transcript: 'x' })), audioFor: jest.fn(async () => null) };
  const search: any = { clarify: jest.fn(), run: jest.fn(async () => undefined) };
  const taskLane: any = { handle: jest.fn(async () => undefined) };
  const reminderLane: any = { handle: jest.fn(async () => undefined) };
  const storyLane: any = { mergeToday: jest.fn(async () => ({ merged: 0, storyDay: "2026-07-04" })) };
  const researchLane: any = { handle: jest.fn(async () => undefined) };
  const askSvc: any = { ask: jest.fn(async () => ({ mode: 'answer', summary: 'ok', cardId: 'c1' })) };
  const talkSvc: any = { talk: jest.fn(async () => ({ conversationId: 'c1', reply: 'hi', sources: [], usedWeb: false })) };
  const settingsSvc: any = { get: jest.fn(async () => ({})), set: jest.fn(async () => ({})) };
  const deviceSvc: any = { turn: jest.fn(async () => ({ ok: true, mode: 'capture', heard: 'x', reply: 'r', say: 's' })), ttsWav16k: jest.fn(async () => Buffer.from('RIFF')), readAudio: jest.fn(() => Buffer.from('RIFFdata')) };
  const notesSvc: any = { create: jest.fn(async () => ({ id: 'n1' })) };
  const ctrl = new EmoController(svc, router, capture, search, taskLane, reminderLane, storyLane, researchLane, askSvc, talkSvc, settingsSvc, deviceSvc, notesSvc, { handle: async () => undefined } as any, { handle: async () => undefined } as any, { handle: async () => undefined } as any);

  it('uploads a recording to the capture pipeline, and rejects an empty upload', async () => {
    await ctrl.upload({ buffer: Buffer.from('audio'), originalname: 'r.webm', mimetype: 'audio/webm' });
    expect(capture.capture).toHaveBeenCalled();
    await expect(ctrl.upload({} as any)).rejects.toThrow(); // no buffer
  });

  it('routes a capture transcript and rejects an empty one', async () => {
    await ctrl.capture({ transcript: 'remind me to call the bank' });
    expect(router.route).toHaveBeenCalledWith('remind me to call the bank', { source: undefined, audioPath: undefined });
    expect(() => ctrl.capture({ transcript: '  ' })).toThrow();
  });

  it('passes feed filters through to the service', async () => {
    await ctrl.list('needs_you' as any, 'search' as any, '2026-07-04', undefined, '20', '0');
    expect(svc.list).toHaveBeenCalledWith({ status: 'needs_you', lane: 'search', day: '2026-07-04', contactId: undefined, take: 20, skip: 0 });
  });

  it('runs the search agent after a search card is answered (BEA-869)', async () => {
    svc.answer.mockResolvedValueOnce({ ok: true, card: { id: 'c1', lane: 'search' } });
    await ctrl.answer('c1', { answer: 'South India' });
    expect(search.run).toHaveBeenCalledWith('c1');
  });

  it('exposes counts, get, answer, update, remove', async () => {
    expect(await ctrl.counts()).toEqual({ needsYou: 1, cooking: 2 });
    await ctrl.answer('c1', { answer: 'yes' });
    expect(svc.answer).toHaveBeenCalledWith('c1', 'yes');
    await ctrl.update('c1', { status: 'done' });
    expect(svc.update).toHaveBeenCalledWith('c1', { status: 'done' });
    expect((await ctrl.remove('c1')).ok).toBe(true);
  });

  it('filters the feed to one person (BEA-1034)', async () => {
    await ctrl.list(undefined, undefined, undefined, 'c1', undefined, undefined);
    expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'c1' }));
  });
});
