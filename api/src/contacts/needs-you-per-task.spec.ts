import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * BEA-1297 — "Needs you" is about a piece of work, not about a person.
 *
 * When the agent got stuck it set `needsOwner` on EVERY active chase for that contact. So the badge
 * said a person needs you and never what about — and since each row in Contacts carries its own
 * task line ("re: Add all videos to the Beacon Hub"), the badge appeared against work that was
 * perfectly fine. Answering one thing then cleared the flag on everything else they were waiting on.
 */

function agent(voice: string, over: { reminders?: any[]; lastIn?: string; flagged?: string[] } = {}) {
  const contact = { id: 'c1', name: 'Deepthi', whatsappNumber: '919812345678' };
  const reminders = over.reminders ?? [
    { id: 'r1', status: 'active', subject: 'the payment amount', taskId: 't1' },
    { id: 'r2', status: 'active', subject: 'the Varisters status', taskId: 't2' },
    { id: 'r3', status: 'active', subject: 'the Elleys PCBs', taskId: 't3' },
  ];
  const state: any = { texts: [] as any[], out: [] as any[], flags: [] as any[] };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: {
      // The clear path asks which rows are currently flagged; everything else asks for the chases.
      findMany: async (args: any) =>
        args?.where?.needsOwner === true ? (over.flagged ?? ['r1', 'r2', 'r3']).map((id: string) => ({ id })) : reminders,
      update: async () => undefined,
      updateMany: async (args: any) => { state.flags.push(args); return { count: 1 }; },
    },
    reminderMessage: {
      findMany: async () => [{ direction: 'in', body: over.lastIn ?? 'sir what is the budget for the Elleys order?', createdAt: new Date() }],
      create: async ({ data }: any) => state.out.push(data),
    },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    task: { findUnique: async () => null, findMany: async () => [] },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = {
    isConfigured: () => true,
    sendText: async (to: string, body: string) => { state.texts.push({ to, body }); return { wamid: 'w1' }; },
    // The owner's alert is the approved template first (BEA-1362); recorded like a text so the
    // "names the work" assertion reads what he was told.
    sendTemplate: async (to: string, _name: string, vars: string[]) => { state.texts.push({ to, body: vars.join(' · '), template: true }); return { wamid: 't1', status: 'sent' }; },
  };
  const { ReminderAgentService } = require('./reminder-agent.service');
  const svc = new ReminderAgentService(
    prisma,
    postbox,
    { voiceComplete: async () => voice, shareLinkFor: async () => null } as any,
    { claim: async () => null, isPending: async () => false } as any,
    { today: () => '2026-08-13', markReceived: async () => undefined, markNotReceived: async () => false, isReceived: async () => false, restDays: async () => ['Sun'] } as any,
    { recordPromise: async () => ({ ok: true }) } as any,
    { get: async () => '' } as any,
    { record: async () => null } as any,
    { recordClaim: async () => ({ claimed: false }) } as any,
  );
  return { svc, state };
}

/** The flag-setting call, whichever shape it took. */
const setFlag = (flags: any[]) => flags.find((f) => f.data?.needsOwner === true);
const clearFlag = (flags: any[]) => flags.find((f) => f.data?.needsOwner === false);

describe('the flag lands on the item it is about (BEA-1297)', () => {
  it('flags ONLY the chase the agent got stuck on', async () => {
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check with Sandeep.","needsSandeep":true,"needsItem":3}');
    await svc.onContactReply('c1');
    const flag = setFlag(state.flags);
    expect(flag.where).toEqual({ id: 'r3' });
    expect(flag.where.contactId).toBeUndefined(); // never the whole person
  });

  it('falls back to the whole person when the model cannot tell which', async () => {
    // Honest rather than a guess: a flag on the wrong item is worse than a vague one.
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check with Sandeep.","needsSandeep":true,"needsItem":null}');
    await svc.onContactReply('c1');
    expect(setFlag(state.flags).where).toMatchObject({ contactId: 'c1', status: 'active' });
  });

  it('ignores a number that matches nothing rather than flagging at random', async () => {
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check.","needsSandeep":true,"needsItem":99}');
    await svc.onContactReply('c1');
    expect(setFlag(state.flags).where).toMatchObject({ contactId: 'c1' });
  });

  it('sets no flag at all when the agent was not stuck', async () => {
    const { svc, state } = agent('{"send":true,"reply":"Thanks!","needsSandeep":false,"needsItem":null}', { lastIn: 'ok sir noted' });
    await svc.onContactReply('c1');
    expect(setFlag(state.flags)).toBeUndefined();
  });
});

describe('the flag is not dropped while the problem is still live (BEA-1297)', () => {
  it('clears it once the agent handles an ordinary exchange', async () => {
    const { svc, state } = agent('{"send":true,"reply":"Thanks Deepthi!","needsSandeep":false}', { lastIn: 'ok sir noted' });
    await svc.onContactReply('c1');
    expect(clearFlag(state.flags)).toBeTruthy();
  });

  it('clears only the ITEM this exchange was about, not everything they owe', async () => {
    // A flag raised on Monday about the payment must not be wiped by a cheerful Wednesday message
    // about the videos — the owner would never learn he still owed an answer. (review finding)
    const { svc, state } = agent('{"send":true,"reply":"Great, thanks!","needsSandeep":false,"done":[3]}', {
      flagged: ['r1'],
      lastIn: 'sir the Elleys PCBs are placed',
    });
    await svc.onContactReply('c1');
    expect(clearFlag(state.flags)).toBeUndefined(); // r1 was about something else — left alone
  });

  it('clears it when THIS exchange settled the flagged item', async () => {
    const { svc, state } = agent('{"send":true,"reply":"Great, thanks!","needsSandeep":false,"done":[1]}', {
      flagged: ['r1'],
      lastIn: 'sir the payment is confirmed',
    });
    await svc.onContactReply('c1');
    expect(clearFlag(state.flags)?.where).toEqual({ id: { in: ['r1'] } });
  });

  it('still clears the whole set when the flag was contact-wide', async () => {
    // Several rows flagged at once is the fallback's signature — it flags every active chase — so
    // clearing them together is right.
    const { svc, state } = agent('{"send":true,"reply":"Thanks!","needsSandeep":false}', { flagged: ['r1', 'r2', 'r3'], lastIn: 'ok sir noted' });
    await svc.onContactReply('c1');
    expect(clearFlag(state.flags)?.where).toEqual({ id: { in: ['r1', 'r2', 'r3'] } });
  });

  it('the owner\'s WhatsApp alert names the work, not just the person', async () => {
    const { svc, state } = agent('{"send":true,"reply":"I\'ll check with Sandeep.","needsSandeep":true,"needsItem":3}');
    await svc.onContactReply('c1');
    const toOwner = state.texts.find((t: any) => t.to === '919885698665');
    expect(toOwner.body).toContain('the Elleys PCBs');
  });

  it('does NOT clear it while they are still raising something', async () => {
    // They can write again about the same problem in words the agent answers politely. Clearing the
    // flag there drops a real question on the floor — the owner never sees it, and they are left
    // waiting on an answer nobody knows they are owed.
    const { svc, state } = agent('{"send":true,"reply":"I understand, let me look into it.","needsSandeep":false}', {
      lastIn: 'sir there is a problem with the payment, the vendor is refusing to release',
    });
    await svc.onContactReply('c1');
    expect(clearFlag(state.flags)).toBeUndefined();
  });
});

describe('the owner can see what it is about (BEA-1297)', () => {
  it('the badge sits on the row, next to that row\'s own task line', () => {
    // The row already prints "re: <task title>", so once the flag lands on the right row it names
    // the work by itself — no new field needed.
    const page = readFileSync(join(__dirname, '../../../web/src/pages/Contacts.tsx'), 'utf8');
    expect(page).toMatch(/rm\.needsOwner &&/);
    expect(page).toMatch(/rm\.task &&.*re:/s);
  });

  it('the model is asked which item, and told not to guess', () => {
    const prompts = readFileSync(join(__dirname, '../prompts/prompts.service.ts'), 'utf8');
    expect(prompts).toContain('"needsItem"');
    expect(prompts).toMatch(/cannot tell, leave "needsItem" null rather than guessing/);
  });
});
