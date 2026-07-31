import { ProfileWriterService } from './profile-writer.service';

/**
 * BEA-1216: the weekly character-profile writer. One living row per contact, one living brain doc
 * — rewritten in place, never duplicated, never written from junk.
 */
const GOOD = `Who they are — Jayanth runs production for Sandeep.
How they work — reports in the evening with real figures.
Reliability — 84% report hit rate in the window.
Recent weeks — sent the OT update daily; flagged a stock shortfall.`;

function make(opts: { llmReply?: string | null; prior?: any; updates?: any[]; briefings?: any[] } = {}) {
  const state: any = { upserts: [], indexed: [], settings: {} as Record<string, string> };
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (state.settings[where.key] ? { key: where.key, value: state.settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => { state.settings[where.key] = update?.value ?? create.value; return {}; },
    },
    contact: {
      findUnique: async () => ({ id: 'c1', name: 'Jayanth', notes: 'production', tags: '[]' }),
      findMany: async ({ where }: any) => (where?.id?.in || []).map((id: string) => ({ id, name: 'Jayanth' })),
    },
    contactProfile: {
      findUnique: async () => opts.prior ?? null,
      findMany: async () => [],
      upsert: async (a: any) => { state.upserts.push(a); return { contactId: a.where.contactId, ...a.create }; },
    },
    teamUpdate: { findMany: async () => opts.updates ?? [{ contactId: 'c1', text: 'OT from 7 to 10, 11 members', at: new Date(), reads: '["status"]' }] },
    briefing: { findMany: async () => opts.briefings ?? [{ rawText: 'He runs the 3rd floor line' }] },
    task: { findMany: async () => [{ title: 'Send the OT update', status: 'open', kind: 'recurring', promiseSlips: 0 }] },
    taskStatusDay: { findMany: async () => [{ status: 'received' }, { status: 'received' }, { status: 'missed' }] },
  };
  const llm: any = { completeHelper: async (_k: string, prompt: string) => { state.prompt = prompt; return opts.llmReply === undefined ? GOOD : opts.llmReply; } };
  const prompts: any = { get: async () => 'Write the profile of {{name}}.' };
  const memory: any = { indexEntity: async (o: any) => { state.indexed.push(o); } };
  const svc = new ProfileWriterService(prisma, llm, prompts, memory);
  return { svc, state };
}

describe('the weekly character profile (BEA-1216)', () => {
  it('rewrites ONE living row and replaces ONE living brain doc — never a duplicate', async () => {
    const { svc, state } = make({ prior: { contactId: 'c1', text: 'old profile', supermemoryId: 'sm-old', ragId: 'rag-old' } });
    const ok = await svc.writeOne('c1', '2026-07-27');
    expect(ok).toBe(true);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].where).toEqual({ contactId: 'c1' }); // same row, updated in place
    expect(state.upserts[0].update.text).toContain('Who they are');
    // The old doc ids ride along so the store deletes before it adds — zero duplicates in RAG.
    expect(state.indexed[0]).toMatchObject({ refType: 'contactprofile', refId: 'c1', prevSupermemoryId: 'sm-old', prevRagId: 'rag-old' });
  });

  it('feeds the model the real facts: their words, the ledger, the briefing, the old profile', async () => {
    const { svc, state } = make({ prior: { contactId: 'c1', text: 'He used to be late with reports' } });
    await svc.writeOne('c1', '2026-07-27');
    expect(state.prompt).toContain('OT from 7 to 10');
    expect(state.prompt).toContain('3rd floor line');
    expect(state.prompt).toContain('67% hit rate'); // 2 in, 1 missed
    expect(state.prompt).toContain('He used to be late with reports');
    expect(state.prompt).toContain('Jayanth');
  });

  it('a junk model reply writes NOTHING — last week\'s good profile survives', async () => {
    const { svc, state } = make({ llmReply: 'ok!' });
    const ok = await svc.writeOne('c1', '2026-07-27');
    expect(ok).toBe(false);
    expect(state.upserts).toHaveLength(0);
    expect(state.indexed).toHaveLength(0);
  });

  it('one attempt per day — a failing run cannot re-call the model every minute', async () => {
    const { svc, state } = make();
    // A Sunday evening in IST: 2026-07-26 was a Sunday; 21:30 IST = 16:00 UTC.
    const sunday = new Date('2026-07-26T16:30:00Z');
    await svc.weeklyTick(sunday);
    const after = state.upserts.length;
    await svc.weeklyTick(sunday); // same day again — the brake holds
    expect(state.upserts.length).toBe(after);
    expect(after).toBeGreaterThan(0); // the first run DID write
  });

  it('a weekday tick checks for catch-up ONCE per day, even when nothing is missing', async () => {
    const { svc, state } = make();
    let sweeps = 0;
    // Everyone already has this week's profile — nothing to catch up.
    (svc as any).prisma.contactProfile.findMany = async () => { sweeps++; return [{ contactId: 'c1' }]; };
    const thursday = new Date('2026-07-30T10:00:00Z');
    await svc.weeklyTick(thursday);
    await svc.weeklyTick(thursday);
    await svc.weeklyTick(thursday);
    expect(sweeps).toBe(1); // the brake holds without a write happening
    expect(state.settings['profile.weeklyTry']).toBe('2026-07-30');
  });

  it('Sunday morning ticks do not burn the day\'s one attempt — the evening write still runs', async () => {
    const { svc, state } = make();
    const sundayMorning = new Date('2026-07-26T04:00:00Z'); // 09:30 IST
    await svc.weeklyTick(sundayMorning);
    expect(state.settings['profile.weeklyTry']).toBeUndefined(); // not burnt
    const sundayEvening = new Date('2026-07-26T16:30:00Z'); // 22:00 IST
    await svc.weeklyTick(sundayEvening);
    expect(state.upserts.length).toBeGreaterThan(0); // the write happened
  });

  it('weekStartOf keys every day of a week to its Monday', () => {
    const { svc } = make();
    expect(svc.weekStartOf('2026-07-27')).toBe('2026-07-27'); // Monday
    expect(svc.weekStartOf('2026-07-30')).toBe('2026-07-27'); // Thursday
    expect(svc.weekStartOf('2026-08-02')).toBe('2026-07-27'); // Sunday belongs to the week it ends
  });
});
