import { EmoCaptureService } from './emo-capture.service';

function make(transcript: string | null) {
  const voice: any = { transcribe: jest.fn(async () => transcript) };
  const router: any = { route: jest.fn(async () => ({ cards: [{ id: 'c1', lane: 'task' }] })) };
  const cards: any = { create: jest.fn(async (d: any) => ({ id: 'note1', ...d })), get: jest.fn(async () => null) };
  return { svc: new EmoCaptureService(voice, router, cards), voice, router, cards };
}

describe('EmoCaptureService (BEA-864/874)', () => {
  it('transcribes in memory and routes the transcript to cards — no audio stored', async () => {
    const { svc, voice, router } = make('finish the BOM by friday');
    const out = await svc.capture(Buffer.from('audio'), 'r.webm', 'audio/webm');
    expect(voice.transcribe).toHaveBeenCalled();
    expect(router.route).toHaveBeenCalledWith('finish the BOM by friday', { source: 'emo-voice' });
    expect(out.transcript).toBe('finish the BOM by friday');
    expect(out.cards).toHaveLength(1);
  });

  it('files a note card to retype when transcription fails (audio is not kept)', async () => {
    const { svc, router, cards } = make('');
    const out = await svc.capture(Buffer.from('audio'), 'r.webm', 'audio/webm');
    expect(router.route).not.toHaveBeenCalled();
    expect(cards.create).toHaveBeenCalledWith(expect.objectContaining({ lane: 'note', status: 'needs_you' }));
    expect(out.cards[0].audioPath).toBeUndefined(); // no audio stored
  });
});
