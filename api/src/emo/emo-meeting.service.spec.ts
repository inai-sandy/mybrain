import { EmoMeetingService } from './emo-meeting.service';

function make(llmOut: string, card: any = { id: 'c1', lane: 'meeting', rawTranscript: 'we agreed to ship friday. raja to send the BOM. vijay to call the vendor.' }) {
  const updates: any[] = [];
  const created: any[] = [];
  const cards: any = { get: jest.fn(async () => card), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return {}; }) };
  const llm: any = { complete: jest.fn(async () => llmOut) };
  const tasks: any = { create: jest.fn(async (d: any) => { const t = { id: `t${created.length + 1}`, ...d }; created.push(t); return t; }) };
  return { svc: new EmoMeetingService(llm, tasks, cards, { get: async () => '' } as any), tasks, updates, created };
}

describe('EmoMeetingService (BEA-868)', () => {
  it('summarises the meeting and turns action items into Tasks', async () => {
    const { svc, tasks, updates, created } = make(JSON.stringify({ summary: '**Key points**\n- ship friday\n**Decisions**\n- go vendor B', actionItems: ['Send the BOM', 'Call the vendor'], attendees: 3 }));
    await svc.handle('c1');
    expect(tasks.create).toHaveBeenCalledTimes(2);
    expect(created[0]).toMatchObject({ category: 'Meeting' });
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.summary).toBe('Meeting — 2 action items');
    expect(done.detail).toContain('Key points');
    expect(done.detail).toContain('### Transcript');
    expect(done.links).toHaveLength(2);
  });

  it('handles a meeting with no action items', async () => {
    const { svc, tasks, updates } = make(JSON.stringify({ summary: 'Quick catch-up, nothing to do.', actionItems: [], attendees: 2 }));
    await svc.handle('c1');
    expect(tasks.create).not.toHaveBeenCalled();
    expect(updates[updates.length - 1].summary).toBe('Meeting summary');
  });

  it('keeps the transcript even if summarisation fails', async () => {
    const { svc, updates } = make('not json at all');
    await svc.handle('c1');
    // JSON.parse of {} → empty summary path still completes as done with transcript
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.detail).toContain('### Transcript');
  });

  it('ignores a non-meeting card', async () => {
    const { svc, tasks } = make('{}', { id: 'c1', lane: 'task' });
    await svc.handle('c1');
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('long meetings (BEA-941): summarised in chunks then merged — the tail of the meeting makes the minutes', async () => {
    const long = Array.from({ length: 40 }, (_, i) => `Speaker ${(i % 2) + 1}: paragraph ${i} ${'x'.repeat(700)}`).join('\n');
    expect(long.length).toBeGreaterThan(12000);
    const updates: any[] = [];
    const cards: any = { get: jest.fn(async () => ({ id: 'c1', lane: 'meeting', rawTranscript: long })), update: jest.fn(async (_id: string, p: any) => { updates.push(p); return {}; }) };
    const llm: any = { complete: jest.fn(async (_p: string, _m: number, tag: string) => {
      if (tag === 'emo-meeting-chunk') return JSON.stringify({ points: ['a point'], decisions: [], actionItems: ['Do the thing'] });
      if (tag === 'emo-meeting-merge') return JSON.stringify({ summary: '**Key points**\n- merged minutes', actionItems: ['Do the thing'], attendees: null });
      return '{}';
    }) };
    const tasks: any = { create: jest.fn(async (d: any) => ({ id: 't1', ...d })) };
    await new EmoMeetingService(llm, tasks, cards, { get: async () => '' } as any).handle('c1');
    const chunkCalls = llm.complete.mock.calls.filter((c: any[]) => c[2] === 'emo-meeting-chunk').length;
    expect(chunkCalls).toBeGreaterThan(1);                       // more than one chunk was read
    expect(llm.complete.mock.calls.some((c: any[]) => c[2] === 'emo-meeting-merge')).toBe(true);
    const done = updates[updates.length - 1];
    expect(done.status).toBe('done');
    expect(done.detail).toContain('merged minutes');
    expect(done.detail).toContain('_Attendees: 2_');             // real count from Speaker labels, not approx
  });
});
