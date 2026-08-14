import { readFileSync } from 'fs';
import { join } from 'path';
import { claimConfirmedLine, withSystemLine, replyWithClaimConfirmation } from './claim-reply';
import { ackLine } from './reminder-agent.service';
import { DelegationService } from '../tasks/delegation.service';

/**
 * BEA-1293 — "done" stops the reminders, and the reply says what stopped.
 *
 * The owner: *"Right now most of my team members are getting frustrated because even if they say
 * the task is done, they keep getting reminders."* Two separate faults sat behind that:
 *
 *  1. A claim only made the sender SKIP each send. The chase still read `active` everywhere, and
 *     from the person's side nothing observable had changed.
 *  2. The reply was written by the model, with a fallback line — "Great, thanks — noted that it's
 *     done!" — that fired whether or not anything had been recorded. A working "done" and a lost
 *     one produced the identical message.
 */

describe('the confirmation names the actual work (BEA-1293)', () => {
  it('names one task, says it is with the owner, and says the reminders stop', () => {
    const line = claimConfirmedLine(['Add all videos to the Beacon Hub']);
    expect(line).toContain('"Add all videos to the Beacon Hub"');
    expect(line).toMatch(/Sandeep/);
    expect(line).toMatch(/reminders/i);
  });

  it('reads properly with two — the three things still hold', () => {
    const line = claimConfirmedLine(['Send the vendor list', 'Close the Elleys order']);
    expect(line).toContain('"Send the vendor list" and "Close the Elleys order"');
    expect(line).toMatch(/them/);
  });

  it('says NOTHING when nothing landed — the whole point of the ticket', () => {
    expect(claimConfirmedLine([])).toBe('');
    expect(claimConfirmedLine([''])).toBe('');
  });

  it('trims a very long title rather than pasting an essay into WhatsApp', () => {
    const line = claimConfirmedLine(['x'.repeat(300)]);
    expect(line.length).toBeLessThan(200);
    expect(line).toContain('…');
  });

  it('rides along with the assistant\'s own words, kept clearly apart', () => {
    expect(withSystemLine('Thanks Dharmendra!', 'LINE')).toBe('Thanks Dharmendra!\n\nLINE');
    expect(withSystemLine('', 'LINE')).toBe('LINE');
    expect(withSystemLine('Just this', '')).toBe('Just this');
  });
});

describe('the outgoing reply once a claim landed (BEA-1293)', () => {
  it('carries the assistant\'s words AND the confirmation naming the task', () => {
    const out = replyWithClaimConfirmation('Thanks Dharmendra, good stuff!', ['Add all videos to the Beacon Hub']);
    expect(out.text).toContain('Thanks Dharmendra, good stuff!');
    expect(out.text).toContain('"Add all videos to the Beacon Hub"');
  });

  it('FORCES the message out — going silent on a completion is what lost their trust', () => {
    // The model is allowed to stay quiet when a message adds nothing. It must not be allowed to
    // stay quiet when somebody has just reported work finished.
    const out = replyWithClaimConfirmation('', ['Send the vendor list']);
    expect(out.forceSend).toBe(true);
    expect(out.text).toContain('"Send the vendor list"');
  });

  it('changes NOTHING when no claim landed — no line, no forced send', () => {
    const out = replyWithClaimConfirmation('Thanks!', []);
    expect(out).toEqual({ text: 'Thanks!', forceSend: false });
  });
});

describe('the fallback ack no longer claims anything was saved (BEA-1293)', () => {
  it('does NOT tell them it is noted as done', () => {
    // This line fires when the model returned nothing to send — i.e. when nothing was recorded.
    // Saying "noted that it's done!" there is the lie that cost the trust.
    const line = ackLine('Karthik', 'sir it is done');
    expect(line.toLowerCase()).not.toContain("noted that it's done");
    expect(line.toLowerCase()).not.toMatch(/marked .* as done/);
  });

  it('still answers them — never leaves anyone on read (BEA-923)', () => {
    expect(ackLine('Karthik', 'sir it is done').trim().length).toBeGreaterThan(0);
    expect(ackLine('Radha', 'sharing the sheet').trim().length).toBeGreaterThan(0);
  });
});

// ---- the chase really pauses ----
function db(over: any = {}) {
  const store: any = {
    task: [{ id: 't1', title: 'Add all videos to the Beacon Hub', kind: over.kind || 'assignment', status: 'open' }],
    reminder: [
      { id: 'r1', taskId: 't1', status: 'active', pausedAuto: false },
      { id: 'r2', taskId: 't1', status: 'paused', pausedAuto: false }, // the OWNER paused this one
      { id: 'elsewhere', taskId: 't2', status: 'active', pausedAuto: false },
    ],
    reminderSend: [{ id: 's1', reminderId: 'r1', status: 'queued' }],
  };
  const match = (r: any, w: any = {}) =>
    Object.entries(w).every(([k, v]: any) => (v && typeof v === 'object' && 'in' in v ? v.in.includes(r[k]) : r[k] === v));
  const prisma: any = {
    task: {
      findUnique: async ({ where }: any) => {
        const t = store.task.find((x: any) => x.id === where.id);
        return t ? { ...t } : null;
      },
    },
    reminder: {
      updateMany: async ({ where, data }: any) => {
        const hit = store.reminder.filter((r: any) => match(r, where));
        hit.forEach((r: any) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
    reminderSend: {
      deleteMany: async ({ where }: any) => {
        const before = store.reminderSend.length;
        store.reminderSend = store.reminderSend.filter((s: any) => s.reminderId !== 'r1' || where === undefined);
        return { count: before - store.reminderSend.length };
      },
    },
  };
  const claims: any = {
    claim: async () => (over.claimReturns === null ? null : { id: 'cl1' }),
    isPending: async () => !!over.alreadyPending,
  };
  const svc = new DelegationService(prisma, {} as any, claims);
  const row = (id: string) => store.reminder.find((r: any) => r.id === id);
  return { svc, store, row };
}

describe('someone saying done PAUSES the chase (BEA-1293)', () => {
  it('pauses it — a real state, not just a skipped send', async () => {
    const { svc, row } = db();
    const res: any = await svc.recordClaim({ taskId: 't1', contactId: 'c1', quote: 'done sir' });
    expect(res.claimed).toBe(true);
    expect(res.task.title).toBe('Add all videos to the Beacon Hub');
    expect(row('r1').status).toBe('paused');
    expect(row('r1').pausedAuto).toBe(true); // the APP paused it, so re-opening may wake it
  });

  it('clears anything already queued, so nothing goes out after they reported it', async () => {
    const { svc, store } = db();
    await svc.recordClaim({ taskId: 't1', contactId: 'c1', quote: 'done sir' });
    expect(store.reminderSend).toHaveLength(0);
  });

  it('leaves another task\'s chase alone', async () => {
    const { svc, row } = db();
    await svc.recordClaim({ taskId: 't1', contactId: 'c1', quote: 'done sir' });
    expect(row('elsewhere').status).toBe('active');
  });

  it('a DAILY report is never paused — tomorrow\'s update still gets asked for', async () => {
    // Pausing Jayanth's production update because today's arrived would kill tomorrow's. The chase
    // going quiet for one day is BEA-1295's job, and it is a different thing.
    const { svc, row } = db({ kind: 'recurring' });
    const res: any = await svc.recordClaim({ taskId: 't1', contactId: 'c1', quote: "today's numbers are 240" });
    expect(res.claimed).toBe(false);
    expect(res.recordedToday).toBe(true);
    expect(row('r1').status).toBe('active');
  });

  it('nothing is paused when the claim did not land — no claim, no silence', async () => {
    const { svc, row } = db({ claimReturns: null });
    const res: any = await svc.recordClaim({ taskId: 't1', contactId: 'c1', quote: 'working on it' });
    expect(res.claimed).toBe(false);
    expect(row('r1').status).toBe('active');
  });

  it('saying it AGAIN is not a fresh claim — the chase stays quiet, nobody is told twice', async () => {
    const { svc, row } = db({ alreadyPending: true });
    const res: any = await svc.recordClaim({ taskId: 't1', contactId: 'c1', quote: 'yes sir done' });
    expect(res.claimed).toBe(false);
    expect(res.alreadyClaimed).toBe(true);
    expect(row('r1').status).toBe('paused'); // still quiet — just no second announcement
  });

  it('resuming wakes only what the APP paused, never what the owner paused himself', async () => {
    const { svc, row } = db();
    await svc.recordClaim({ taskId: 't1', contactId: 'c1', quote: 'done sir' });
    const n = await svc.resumeChases('t1');
    expect(n).toBe(1);
    expect(row('r1').status).toBe('active');
    expect(row('r2').status).toBe('paused'); // his own hand — left alone
  });
});

// ---- the agent's real branch, end to end ----
/**
 * The existing agent spec builds this service with 8 positional arguments, so `delegation` is
 * undefined in every one of its scenarios and they all exercise the OLD fallback branch. Deleting
 * the entire fix would not have failed one of them. (review finding, BEA-1293)
 */
function agent(voice: string, over: { recordClaim?: any; reminders?: any[] } = {}) {
  const contact = { id: 'c1', name: 'Dharmendra', whatsappNumber: '919812345678' };
  const reminders = over.reminders ?? [{ id: 'r1', status: 'active', subject: 'the Beacon Hub videos', taskId: 't1' }];
  const state: any = { texts: [] as any[], out: [] as any[] };
  const prisma: any = {
    contact: { findUnique: async () => contact },
    reminder: { findMany: async () => reminders, update: async () => undefined, updateMany: async () => undefined },
    reminderMessage: { findMany: async () => [{ direction: 'in', body: 'sir it is done, all videos uploaded' }], create: async ({ data }: any) => state.out.push(data) },
    setting: { findUnique: async () => ({ value: '919885698665' }) },
    task: { findUnique: async () => null, findMany: async () => [] },
    briefing: { findMany: async () => [] },
  };
  const postbox: any = { isConfigured: () => true, sendText: async (to: string, body: string) => { state.texts.push({ to, body }); return { wamid: 'w1' }; } };
  const delegation: any = { recordClaim: over.recordClaim ?? (async () => ({ claimed: true, task: { title: 'Add all videos to the Beacon Hub' } })) };
  const svc = new (require('./reminder-agent.service').ReminderAgentService)(
    prisma,
    postbox,
    { voiceComplete: async () => voice } as any,
    { claim: async () => ({ id: 'cl1' }), isPending: async () => false } as any,
    { today: () => '2026-08-13', markReceived: async () => undefined, isReceived: async () => false, restDays: async () => ['Sun'] } as any,
    { recordPromise: async () => ({ ok: true }) } as any,
    { get: async () => '' } as any,
    { record: async () => null } as any,
    delegation,
  );
  return { svc, state };
}

describe('what the person actually receives (BEA-1293)', () => {
  const DONE = '{"send":true,"reply":"Nice one Dharmendra!","needsSandeep":false,"done":[1]}';

  it('the sent message NAMES the task — the owner\'s actual ask', async () => {
    const { svc, state } = agent(DONE);
    await svc.onContactReply('c1');
    expect(state.texts).toHaveLength(1);
    expect(state.texts[0].body).toContain('Add all videos to the Beacon Hub');
    expect(state.texts[0].body).toMatch(/reminders/i);
    expect(state.texts[0].body).toContain('Nice one Dharmendra!'); // the assistant's own words survive
  });

  it('says it even when the model wanted to stay quiet', async () => {
    const { svc, state } = agent('{"send":false,"reply":"","needsSandeep":false,"done":[1]}');
    await svc.onContactReply('c1');
    expect(state.texts[0].body).toContain('Add all videos to the Beacon Hub');
  });

  it('says NOTHING of the sort when the claim did not land', async () => {
    // The exact failure being fixed: a message that reads like a confirmation over a database that
    // recorded nothing.
    const { svc, state } = agent(DONE, { recordClaim: async () => ({ claimed: false, task: { title: 'Add all videos to the Beacon Hub' } }) });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/marked .* as done/i);
    expect(state.texts[0].body).not.toMatch(/won't get reminders/i);
  });

  it('does not repeat itself when they simply say it again', async () => {
    // `claim()` is idempotent, so every later pass looked like a fresh claim and the confirmation
    // was force-sent again. One piece of work, one confirmation. (review finding)
    const { svc, state } = agent(DONE, { recordClaim: async () => ({ claimed: false, alreadyClaimed: true, task: { title: 'Add all videos to the Beacon Hub' } }) });
    await svc.onContactReply('c1');
    expect(state.texts[0].body).not.toMatch(/marked .* as done/i);
  });
});

describe('a paused chase is still reached by the grace-period sweep (BEA-1293)', () => {
  /**
   * The rule the owner picked: *"pause it, wait for me, stop after the grace period."*
   *
   * `rollDay`'s sweep only looked at `status: 'active'`. The moment a claim started PAUSING the
   * chase, every claim-paused row became invisible to it — and with it the two-day auto-stop. A
   * claim he never got round to reviewing would have sat paused forever, which is "stop on done"
   * wearing the word "pause". (review finding)
   */
  function sender(over: { claimAt?: Date | null; graceDays?: string; taskStatus?: string } = {}) {
    const updates: any[] = [];
    const paused = [{ id: 'p1', status: 'paused', pausedAuto: true, armedDay: '2026-08-13', times: '["09:00"]', taskId: 't1' }];
    const prisma: any = {
      // where-aware on purpose: the whole finding is that one query missed a set of rows.
      reminder: {
        findMany: async ({ where }: any) => (where?.status === 'paused' ? paused : []),
        update: async ({ where, data }: any) => { updates.push({ id: where.id, ...data }); return {}; },
      },
      reminderSend: { count: async () => 0, deleteMany: async () => ({}), createMany: async () => ({ count: 0 }), create: async (d: any) => d },
      setting: { findUnique: async () => (over.graceDays === undefined ? null : { value: over.graceDays }) },
      taskClaim: { findFirst: async () => (over.claimAt ? { createdAt: over.claimAt } : null) },
      task: { findUnique: async () => ({ promisedFor: null, status: over.taskStatus || 'open' }) },
    };
    const { ReminderSenderService } = require('./reminder-sender.service');
    const recurringOff: any = { today: () => '2026-08-13', isReceived: async () => false, restDays: async () => ['Sun'] };
    return { svc: new ReminderSenderService(prisma, { isConfigured: () => false } as any, { share: async () => ({ slug: 'x-1234' }) } as any, recurringOff), updates };
  }

  it('stops a claim-paused chase once the grace period runs out', async () => {
    const { svc, updates } = sender({ claimAt: new Date(Date.now() - 3 * 86400000), graceDays: '2' });
    await svc.rollDay();
    // `stopped` rather than `done`: this is the end of the road, not work that finished. Only
    // `done` is revived when the owner re-opens the job. (BEA-1317)
    expect(updates).toContainEqual({ id: 'p1', status: 'stopped' });
  });

  it('leaves it paused while the claim is still fresh — it is waiting for HIM', async () => {
    const { svc, updates } = sender({ claimAt: new Date(), graceDays: '2' });
    await svc.rollDay();
    expect(updates.find((u) => u.status === 'done')).toBeUndefined();
    expect(updates.find((u) => u.status === 'active')).toBeUndefined(); // never re-armed behind his back
  });

  it('"never" means it waits for him however long that takes', async () => {
    const { svc, updates } = sender({ claimAt: new Date(Date.now() - 400 * 86400000), graceDays: 'never' });
    await svc.rollDay();
    expect(updates.find((u) => u.status === 'done')).toBeUndefined();
  });

  it('stops it when the work turned out to be finished anyway', async () => {
    const { svc, updates } = sender({ taskStatus: 'done' });
    await svc.rollDay();
    expect(updates).toContainEqual({ id: 'p1', status: 'done' });
  });
});

describe('every surface goes through the same door (BEA-1293)', () => {
  const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

  it('the WhatsApp agent records claims through it, so the chase pauses there too', () => {
    const src = read('reminder-agent.service.ts');
    expect(src).toContain('delegation.recordClaim');
    // The CALL, not the import. Grepping for the symbol alone matched the import line, so removing
    // the whole assembly left every test green — the negative control proved nothing.
    expect(src).toMatch(/replyWithClaimConfirmation\(replyText, claimedTitles\)/);
    expect(src).toMatch(/replyText = confirmed\.text/);
  });

  it('a tick on their own page pauses it the same way', () => {
    const src = read('share.controller.ts');
    expect(src).toContain('delegation.recordClaim');
    expect(src).not.toMatch(/claims\.claim\(/);
  });

  it('un-ticking on their page puts the chase BACK — a mis-tap must not silence it forever', () => {
    const src = read('share.controller.ts');
    const block = src.slice(src.indexOf('done === false'), src.indexOf('done === false') + 400);
    expect(block).toContain('resumeChases');
  });

  it('a paused chase is skipped, not reported as a failure', () => {
    // Since a claim now pauses, this is the ordinary path. Marking it "failed" put a red row in
    // front of the owner for the system working exactly as intended.
    const src = read('reminder-sender.service.ts');
    expect(src).toMatch(/paused \? 'skipped' : 'failed'/);
  });

  it('the owner\'s list SHOWS the paused state instead of calling it "no chase"', () => {
    const page = readFileSync(join(__dirname, '../../../web/src/pages/taskShared.tsx'), 'utf8');
    expect(page).toMatch(/chaseStatus === 'paused'/);
    expect(page).toMatch(/paused — they say it/);
  });
});
