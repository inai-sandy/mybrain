jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, promises: { ...actual.promises, readFile: jest.fn(async () => Buffer.from('audio')), unlink: jest.fn(async () => undefined) } };
});

import { MeetingsService } from './meetings.service';

// BEA-805: the audio must NOT be auto-deleted when the AI summary failed (empty), or the meeting is
// left permanently without a summary and no way to retry (transcribe needs the audio).
function make(llmText: string) {
  const meeting: any = { id: 'm1', audioPath: '/tmp/a.webm', audioMime: 'audio/webm', status: 'recorded', title: 'New recording', agenda: null };
  const settings: Record<string, string> = { 'meetings.autoDeleteAudio': 'true' };
  const prisma: any = {
    meeting: {
      findUnique: async () => meeting,
      update: async ({ data }: any) => { Object.assign(meeting, data); return meeting; },
    },
    setting: { findUnique: async ({ where }: any) => (where.key in settings ? { key: where.key, value: settings[where.key] } : null) },
  };
  const voice: any = { transcribeWith: async () => 'a full transcript of the meeting' };
  const llm: any = { complete: async () => llmText, completeWith: async () => llmText };
  const prompts: any = { get: async () => 'summarize:' };
  const memory: any = { indexEntity: async () => undefined, sourceEnabled: () => true };
  const svc = new MeetingsService(prisma, voice, llm, prompts, memory);
  const delSpy = jest.spyOn(svc, 'deleteAudio').mockResolvedValue({ ok: true } as any);
  jest.spyOn(svc, 'get').mockResolvedValue(meeting as any);
  return { svc, delSpy, meeting };
}

describe('MeetingsService.transcribe — keep audio if summary failed (BEA-805)', () => {
  it('does NOT delete the audio when the summary came back empty', async () => {
    const { svc, delSpy } = make(''); // LLM hiccup → empty summary
    await svc.transcribe('m1');
    expect(delSpy).not.toHaveBeenCalled();
  });

  it('deletes the audio when the summary succeeded (auto-delete on)', async () => {
    const { svc, delSpy } = make('{"summary":"We agreed on the plan.","takeaways":["a"]}');
    await svc.transcribe('m1');
    expect(delSpy).toHaveBeenCalledWith('m1');
  });
});
