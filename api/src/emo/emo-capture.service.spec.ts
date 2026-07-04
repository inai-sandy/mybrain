jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, promises: { ...actual.promises, mkdir: jest.fn(async () => undefined), writeFile: jest.fn(async () => undefined) } };
});

import { EmoCaptureService } from './emo-capture.service';

function make(transcript: string | null) {
  const voice: any = { transcribe: jest.fn(async () => transcript) };
  const router: any = { route: jest.fn(async () => ({ cards: [{ id: 'c1', lane: 'task' }] })) };
  const cards: any = { create: jest.fn(async (d: any) => ({ id: 'note1', ...d })), get: jest.fn(async () => null) };
  return { svc: new EmoCaptureService(voice, router, cards), voice, router, cards };
}

describe('EmoCaptureService (BEA-864)', () => {
  it('saves + transcribes a recording and routes the transcript to cards', async () => {
    const { svc, voice, router } = make('finish the BOM by friday');
    const out = await svc.capture(Buffer.from('audio'), 'r.webm', 'audio/webm');
    expect(voice.transcribe).toHaveBeenCalled();
    expect(router.route).toHaveBeenCalledWith('finish the BOM by friday', expect.objectContaining({ source: 'emo-voice' }));
    expect(out.transcript).toBe('finish the BOM by friday');
    expect(out.cards).toHaveLength(1);
  });

  it('keeps the recording as a note card when transcription fails — nothing is lost', async () => {
    const { svc, router, cards } = make('');
    const out = await svc.capture(Buffer.from('audio'), 'r.webm', 'audio/webm');
    expect(router.route).not.toHaveBeenCalled();
    expect(cards.create).toHaveBeenCalledWith(expect.objectContaining({ lane: 'note', status: 'needs_you' }));
    expect(out.cards[0].audioPath).toMatch(/\.webm$/); // the audio is still kept
  });
});
