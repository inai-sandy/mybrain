import { readFileSync } from 'fs';
import { join } from 'path';
import { ContactsService } from './contacts.service';

/**
 * BEA-1307 — a person can leave, without being deleted.
 *
 * Radha left the organisation and there was no correct action available:
 *
 *  - **Delete** cascades away every briefing the owner ever wrote about her, every word she said,
 *    her weekly profile and every chase — and leaves her WhatsApp history as rows nothing can reach
 *    again, because a conversation only surfaces through a reminder.
 *  - **Stop each chase by hand**, one at a time, and nothing at all for her open work.
 *
 * His words: *"I cannot remove the person. I cannot stop his reminders. Why is it not a full
 * circle? The system is like a patchwork today."*
 *
 * Left is not deleted: out of the working system, every record intact.
 */

function svc(over: any = {}) {
  const contact = 'contact' in over ? over.contact : { id: 'c1', name: 'Radha', leftAt: null };
  const state: any = { saved: null, chases: null, sendsCleared: false, deleted: false };
  const prisma: any = {
    contact: {
      findUnique: async () => contact,
      update: async ({ data }: any) => { state.saved = data; return { ...contact, ...data }; },
      delete: async () => { state.deleted = true; return contact; },
      findMany: async ({ where }: any) => { state.listWhere = where; return over.rows || []; },
      count: async () => (over.rows || []).length,
    },
    reminder: { updateMany: async (a: any) => { state.chases = a; return { count: over.chaseCount ?? 2 }; }, count: async () => over.chases ?? 0 },
    reminderSend: { deleteMany: async () => { state.sendsCleared = true; return { count: 0 }; } },
    task: {
      findMany: async ({ where }: any) => { state.workWhere = where; return over.openWork || []; },
      count: async () => over.taskCount ?? 0,
      groupBy: async () => [],
    },
    briefing: { count: async () => over.briefings ?? 0 },
    contactProfile: { count: async () => over.profileRows ?? 0 },
    teamUpdate: { count: async () => over.updates ?? 0 },
    reminderMessage: { count: async () => over.messages ?? 0 },
  };
  return { svc: new ContactsService(prisma), state };
}

describe('marking someone as left (BEA-1307)', () => {
  it('records when, and turns their page off', async () => {
    const { svc: s, state } = svc();
    await s.markLeft('c1', 'moved on 14 Aug');
    expect(state.saved.leftAt).toBeInstanceOf(Date);
    expect(state.saved.leftNote).toBe('moved on 14 Aug');
    expect(state.saved.shareEnabled).toBe(false);
  });

  it('stops every chase — as the OWNER stopping it, not the app', async () => {
    // `stopped` is his hand; `done` is what the app writes when it decides, and those get offered
    // back for resuming. "They have left" is not a suggestion to reconsider. (BEA-1160)
    const { svc: s, state } = svc();
    const res: any = await s.markLeft('c1');
    expect(state.chases.data).toEqual({ status: 'stopped' });
    expect(state.chases.where).toMatchObject({ contactId: 'c1' });
    expect(res.stoppedChases).toBe(2);
    expect(state.sendsCleared).toBe(true); // nothing already queued goes out either
  });

  it('hands back their open work rather than deciding for him', async () => {
    // What happens to it is a decision — hand it on, or close it as not done. Making that decision
    // silently is how work disappears without anyone noticing.
    const { svc: s, state } = svc({ openWork: [{ id: 't1', title: 'Work on the new production stock plan', kind: 'assignment' }] });
    const res: any = await s.markLeft('c1');
    expect(res.openWork).toHaveLength(1);
    expect(res.openWork[0].title).toContain('production stock plan');
    expect(state.workWhere).toMatchObject({ ownerContactId: 'c1', status: 'open' });
  });

  it('destroys nothing', async () => {
    const { svc: s, state } = svc();
    await s.markLeft('c1');
    expect(state.deleted).toBe(false);
  });

  it('doing it twice changes nothing and does not restamp the date', async () => {
    const { svc: s, state } = svc({ contact: { id: 'c1', name: 'Radha', leftAt: new Date('2020-01-01') } });
    const res: any = await s.markLeft('c1');
    expect(res.alreadyLeft).toBe(true);
    expect(state.saved).toBeNull();
  });

  it('a missing person is a clear error, not a silent success', async () => {
    const { svc: s } = svc({ contact: null });
    await expect(s.markLeft('gone')).rejects.toThrow(/not found/i);
  });
});

describe('coming back (BEA-1307)', () => {
  it('restores them, and turns their page back on', async () => {
    const { svc: s, state } = svc({ contact: { id: 'c1', name: 'Radha', leftAt: new Date() } });
    await s.markBack('c1');
    expect(state.saved).toMatchObject({ leftAt: null, leftNote: null, shareEnabled: true });
  });

  it('does NOT resurrect their chases', async () => {
    // Waking several chases at once would put messages in front of a real person because of a
    // status change on a screen. Restarting them is a decision, one at a time. (BEA-1160)
    const { svc: s, state } = svc({ contact: { id: 'c1', name: 'Radha', leftAt: new Date() } });
    await s.markBack('c1');
    expect(state.chases).toBeNull();
  });
});

describe('they are out of the working system, not out of the record (BEA-1307)', () => {
  it('never offered when picking who to give work to', async () => {
    const { svc: s, state } = svc({ rows: [] });
    await s.allForPicker();
    expect(state.listWhere).toMatchObject({ leftAt: null });
  });

  it('out of the list by default, and one filter away', async () => {
    const active = svc({ rows: [] });
    await active.svc.list(undefined, 1, 20);
    expect(active.state.listWhere.leftAt).toBeNull();

    const left = svc({ rows: [] });
    await left.svc.list(undefined, 1, 20, 'left');
    expect(left.state.listWhere.leftAt).toEqual({ not: null });

    const all = svc({ rows: [] });
    await all.svc.list(undefined, 1, 20, 'all');
    expect(all.state.listWhere.leftAt).toBeUndefined();
  });

  /**
   * These CALL the code with a departed contact rather than grepping the file for `leftAt`.
   *
   * The grep version is why the worst hole in this change went unnoticed: the two-way agent had no
   * guard at all, and no test looked at it, because the tests were checking that a token appeared in
   * two other files. A logic inversion would have satisfied them just as well. (review finding)
   */
  const gone = { id: 'c1', name: 'Radha', whatsappNumber: '9190', leftAt: new Date() };

  it('no new chase can be created for them', async () => {
    const { RemindersService } = require('./reminders.service');
    const prisma: any = { contact: { findUnique: async () => gone }, reminder: { create: async () => { throw new Error('should never reach here'); } } };
    const r: any = new RemindersService(prisma, {} as any, {} as any, {} as any);
    await expect(r.create({ contactId: 'c1', message: 'where is this?' })).rejects.toThrow(/has left/i);
  });

  it('a manual message from the owner is refused too', async () => {
    // Their old chat thread is still readable, so typing into it is a real path to messaging them.
    const { RemindersService } = require('./reminders.service');
    const prisma: any = { contact: { findUnique: async () => gone } };
    const r: any = new RemindersService(prisma, {} as any, {} as any, {} as any);
    r.anchorFor = async () => ({ contact: gone, reminder: null });
    await expect(r.sendManual('rid', 'hello?')).rejects.toThrow(/has left/i);
    await expect(r.resendTemplate('rid')).rejects.toThrow(/has left/i);
  });

  it('the AGENT does not reply to them, and tells the owner instead', async () => {
    // The worst of the holes: she messages, and an AI carries on a conversation on the owner's
    // behalf with somebody who no longer works here.
    const { ReminderAgentService } = require('./reminder-agent.service');
    const sent: any[] = [];
    const prisma: any = {
      contact: { findUnique: async () => gone },
      reminderMessage: { findFirst: async () => ({ body: 'sir any update on my dues?' }), findMany: async () => [], create: async () => undefined },
      reminder: { findMany: async () => [{ id: 'r1', status: 'stopped' }], updateMany: async () => undefined },
      setting: { findUnique: async () => ({ value: '919885698665' }) },
      task: { findUnique: async () => null, findMany: async () => [] },
      briefing: { findMany: async () => [] },
    };
    const postbox: any = {
      isConfigured: () => true,
      sendText: async (to: string, body: string) => { sent.push({ to, body }); return { wamid: 'w' }; },
      sendTemplate: async (to: string, _name: string, vars: string[]) => { sent.push({ to, body: vars.join(' · '), template: true }); return { wamid: 't', status: 'sent' }; }, // owner alert = template first (BEA-1362)
    };
    const llm = { voiceComplete: async () => { throw new Error('the model must not be asked'); } };
    const agent: any = new ReminderAgentService(
      prisma, postbox, llm as any,
      { claim: async () => null, isPending: async () => false } as any,
      { today: () => '2026-08-14', markReceived: async () => undefined, isReceived: async () => false, restDays: async () => ['Sun'] } as any,
      { recordPromise: async () => ({ ok: true }) } as any,
      { get: async () => '' } as any,
      { record: async () => null } as any,
    );
    await agent.onContactReply('c1');
    // Nothing went to HER.
    expect(sent.filter((m) => m.to === '9190')).toHaveLength(0);
    // And the owner was told, so he can answer himself if he wants to.
    const toOwner = sent.find((m) => m.to === '919885698665');
    expect(toOwner).toBeTruthy();
    expect(toOwner.body).toMatch(/has left/i);
  });

  it('NO new work can be given to them — not by picker, not by id, not by @mention', async () => {
    // The picker hid them and nothing else did. An explicit `ownerContactId`, a typed party name, or
    // "@Radha to send the report" in a brain-dump would all still have handed work to somebody who
    // left. The picker is one door of four. (review finding)
    const { TasksService } = require('../tasks/tasks.service');
    const prisma: any = {
      contact: {
        // The real query filters `leftAt: null`; this stub honours that so the test exercises the
        // filter rather than assuming it.
        findMany: async ({ where }: any) => (where?.leftAt === null ? [] : [{ id: 'c1', name: 'Radha', aliases: '[]' }]),
        findUnique: async () => ({ name: 'Radha', leftAt: new Date() }),
      },
      task: { create: async () => { throw new Error('a task must never be created for someone who left'); } },
      setting: { findUnique: async () => null },
      taskPerson: { findMany: async () => [], deleteMany: async () => ({}), createMany: async () => ({}) },
    };
    const t: any = new TasksService(prisma, {} as any, {} as any, {} as any);
    await expect(t.create({ title: 'Send the report', ownerContactId: 'c1' })).rejects.toThrow(/has left/i);

    // …and by name, the task is still created — it simply belongs to nobody rather than to her.
    const byName: any = { ...prisma, task: { create: async ({ data }: any) => ({ id: 'x', ...data }) } };
    const t2: any = new TasksService(byName, {} as any, {} as any, {} as any);
    t2.indexTask = () => undefined; t2.touchPerson = () => undefined; t2.syncPeople = async () => undefined; t2.shape = (x: any) => x;
    const made = await t2.create({ title: 'Send the report', party: 'Radha' });
    expect(made.ownerContactId).toBeNull();
  });

  it('and the scheduled sender refuses a chase created before they left', () => {
    const src = readFileSync(join(__dirname, 'reminder-sender.service.ts'), 'utf8');
    expect(src).toMatch(/leftAt/);
    expect(src).toMatch(/they have left/i);
  });
});

describe('deleting is honest about what it destroys (BEA-1307)', () => {
  it('refuses while there is real history, and says exactly what would go', async () => {
    const { svc: s, state } = svc({ briefings: 3, updates: 12, messages: 240, taskCount: 4 });
    await expect(s.remove('c1')).rejects.toThrow(/3 briefings.*12 updates.*240 WhatsApp messages.*4 tasks/s);
    expect(state.deleted).toBe(false);
  });

  it('points at the thing he actually wanted', async () => {
    const { svc: s } = svc({ briefings: 1 });
    await expect(s.remove('c1')).rejects.toThrow(/mark them as left instead/i);
  });

  it('still deletes a contact created by mistake, with nothing behind them', async () => {
    const { svc: s, state } = svc({});
    const res: any = await s.remove('c1');
    expect(res.ok).toBe(true);
    expect(state.deleted).toBe(true);
  });

  it('counts EVERY table that cascades, not just the obvious four', async () => {
    // The first version counted briefings/updates/messages/tasks while the docstring promised the
    // profile and the chases too — so a contact with only those two had "no history", deleted
    // without a word, and lost both. A warning wrong about what it protects is worse than none.
    const { svc: s } = svc({ chases: 2, profileRows: 1 });
    await expect(s.remove('c1')).rejects.toThrow(/2 chases.*their profile/s);
  });

  it('and deletes anyway when he insists', async () => {
    const { svc: s, state } = svc({ briefings: 3, messages: 100 });
    const res: any = await s.remove('c1', true);
    expect(state.deleted).toBe(true);
    expect(res.destroyed).toMatchObject({ briefings: 3, messages: 100 });
  });
});

describe('the screens offer it (BEA-1307)', () => {
  const page = readFileSync(join(__dirname, '../../../web/src/pages/Contacts.tsx'), 'utf8');

  it('there is a "they have left" action, and a way back', () => {
    expect(page).toContain('markLeft');
    expect(page).toContain('markBack');
  });

  it('someone who has left is labelled wherever they appear', () => {
    expect(page).toMatch(/c\.hasLeft &&/);
  });

  it('delete warns about what it destroys and points at leaving instead', () => {
    const block = page.slice(page.indexOf('delFor && ('), page.indexOf('delFor && (') + 700);
    expect(block).toMatch(/every briefing/i);
    expect(block).toMatch(/They have left.*instead/is);
  });
});
