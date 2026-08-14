import { TasksService } from './tasks.service';
import { ClaimsService } from './claims.service';
import { DelegationService } from './delegation.service';

/**
 * BEA-1296 — every door reaches the same room.
 *
 * The owner: *"There has to be some link between the Delegated tasks and the reminders and Needs
 * You... If the link is not proper, we will fail miserably."*
 *
 * The failure was never one broken screen. It was four routes to one outcome, each written out by
 * hand, so a surface that remembered three of the four steps left a person being chased about work
 * that was finished — and no test noticed, because each route was tested against its own stub.
 *
 * So these tests do the opposite: one shared in-memory database, four entry points, and the SAME
 * end state asserted on the stored rows rather than on what a method returned. A method can return
 * `{ok: true}` over a database that never changed.
 */

// ---- a small stand-in database, so assertions read the rows rather than the calls ----
const matches = (row: any, where: any = {}): boolean =>
  Object.entries(where).every(([k, cond]: [string, any]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return (cond.in as any[]).includes(row[k]);
      if ('not' in cond) return row[k] !== cond.not;
      // a relation filter, e.g. reminderSend.deleteMany({ where: { reminder: { taskId } } })
      return true;
    }
    return row[k] === cond;
  });

function db() {
  const store: any = {
    task: [{ id: 't1', title: 'Add all videos to the Beacon Hub', status: 'open', progress: 50, kind: 'assignment', ownerContactId: 'c1', party: 'Dharmendra', priority: 'medium', reminderCount: 0, reminders: null }],
    reminder: [
      { id: 'r1', taskId: 't1', status: 'active', repeat: 'daily', needsOwner: true, pausedAuto: false },
      { id: 'r2', taskId: 't1', status: 'paused', repeat: 'none', needsOwner: true, pausedAuto: true },
      { id: 'other', taskId: 't2', status: 'active', repeat: 'daily', needsOwner: true, pausedAuto: false },
    ],
    reminderSend: [{ id: 's1', reminderId: 'r1', status: 'queued' }],
    taskClaim: [{ id: 'cl1', taskId: 't1', status: 'pending', quote: 'sir it is done', contactId: 'c1' }],
    teamUpdate: [{ id: 'u1', taskId: 't1', closedAt: null }],
  };
  // Reads hand back a COPY, exactly as Prisma does. Returning the live object let a service compare
  // the row it had just written against itself — `if (next !== previous)` was false, the shared rule
  // never ran, and the test failed for a reason that existed only in the stub.
  const copy = (r: any) => (r ? { ...r } : r);
  const table = (name: string) => ({
    findUnique: async ({ where }: any) => copy(store[name].find((r: any) => r.id === where.id)) || null,
    findFirst: async ({ where }: any) => copy(store[name].find((r: any) => matches(r, where))) || null,
    findMany: async ({ where }: any = {}) => store[name].filter((r: any) => matches(r, where)).map(copy),
    count: async ({ where }: any = {}) => store[name].filter((r: any) => matches(r, where)).length,
    update: async ({ where, data }: any) => {
      const row = store[name].find((r: any) => r.id === where.id);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      const hit = store[name].filter((r: any) => matches(r, where));
      hit.forEach((r: any) => Object.assign(r, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: any) => {
      const before = store[name].length;
      store[name] = store[name].filter((r: any) => !matches(r, where));
      return { count: before - store[name].length };
    },
    create: async ({ data }: any) => { const row = { id: `new-${store[name].length}`, ...data }; store[name].push(row); return row; },
  });
  const prisma: any = {
    task: table('task'), reminder: table('reminder'), reminderSend: table('reminderSend'),
    taskClaim: table('taskClaim'), teamUpdate: table('teamUpdate'),
    contact: { findMany: async () => [] },
    taskPerson: { findMany: async () => [], deleteMany: async () => ({}), createMany: async () => ({}) },
  };
  const tasks: any = new TasksService(prisma, {} as any, {} as any, {} as any);
  tasks.indexTask = () => undefined;
  tasks.touchPerson = () => undefined;
  tasks.allContacts = async () => [];
  tasks.syncPeople = async () => undefined;
  tasks.shape = (x: any) => x;
  tasks.spawnFollowUp = async () => null;
  const claims = new ClaimsService(prisma, { today: () => '2026-08-13', markReceived: async () => undefined } as any);
  const delegation = new DelegationService(prisma, tasks, claims);
  const row = (name: string, id: string) => store[name].find((r: any) => r.id === id);
  return { store, prisma, tasks, claims, delegation, row };
}

/** The complete end state, whichever door was used. */
function finishedState(row: (n: string, id: string) => any) {
  return {
    task: row('task', 't1').status,
    chase: row('reminder', 'r1').status,
    pausedChase: row('reminder', 'r2').status,
    needsYou: row('reminder', 'r1').needsOwner,
    claim: row('taskClaim', 'cl1').status,
    teamUpdateClosed: row('teamUpdate', 'u1').closedAt !== null,
  };
}

const FINISHED = { task: 'done', chase: 'done', pausedChase: 'done', needsYou: false, claim: 'confirmed', teamUpdateClosed: true };

describe('finishing delegated work lands in the same place from every screen (BEA-1296)', () => {
  it('from Tasks — the tick', async () => {
    const { tasks, row } = db();
    await tasks.setDone('t1', true);
    expect(finishedState(row)).toEqual(FINISHED);
  });

  it('from the edit form — dragging progress to 100', async () => {
    // This route used to stop the chase and nothing else: the pending claim stayed pending and was
    // swept straight back into the review list.
    const { tasks, row } = db();
    await tasks.update('t1', { progress: 100 });
    expect(finishedState(row)).toEqual(FINISHED);
  });

  it('from the claim review — confirming what they said', async () => {
    const { delegation, row } = db();
    await delegation.decideClaim('cl1', true);
    expect(finishedState(row)).toEqual(FINISHED);
  });

  it('from the team-updates inbox — "yes, all done"', async () => {
    const { delegation, row } = db();
    await delegation.finishTask('t1', true);
    expect(finishedState(row)).toEqual(FINISHED);
  });

  it('several claims at once land there too', async () => {
    const { delegation, row } = db();
    await delegation.decideManyClaims(['cl1', 'does-not-exist'], true);
    expect(finishedState(row)).toEqual(FINISHED);
  });

  it('queued messages are cleared, so nothing already scheduled still goes out', async () => {
    const { tasks, store } = db();
    await tasks.setDone('t1', true);
    expect(store.reminderSend).toHaveLength(0);
  });

  // ---- the job page is the FIFTH door (BEA-1310/1315) ----
  //
  // It shows the whole story of one job and now acts on it too. It was written to reuse the same
  // endpoints, but "was written to" is not a guarantee — so it is asserted here with the others,
  // against the same shared database, rather than trusted.
  it('from the job page — the tick', async () => {
    // `POST /tasks/:id/done {done:true}` — what the Mark done button sends.
    const { tasks, row } = db();
    await tasks.setDone('t1', true);
    expect(finishedState(row)).toEqual(FINISHED);
  });

  it('from the job page — answering the claim there', async () => {
    // `POST /tasks/claims/:id/decide {confirm:true}` — the "Yes, it is done" button. It answers the
    // CLAIM rather than ticking the task, which is why the claim ends up confirmed instead of
    // sitting pending under a finished job.
    const { delegation, row } = db();
    await delegation.decideClaim('cl1', true);
    expect(finishedState(row)).toEqual(FINISHED);
  });

  it('another person\'s chase is untouched — the switch is per task, not global', async () => {
    const { tasks, row } = db();
    await tasks.setDone('t1', true);
    expect(row('reminder', 'other')).toMatchObject({ status: 'active', needsOwner: true });
  });
});

describe('closing it as NOT done stops the chase just as hard (BEA-1306/1315)', () => {
  // The job page's "Not doing it" (and "Stop this report" on a daily report). The chase must stop —
  // being messaged every morning about work you have already decided against is the exact
  // frustration this whole run exists to remove — but nobody is thanked for finishing it.
  it('the chase stops, the badge clears, and the claim is settled as moot', async () => {
    const { tasks, row } = db();
    await tasks.setDropped('t1', 'Radha left the organisation');
    expect({
      task: row('task', 't1').status,
      chase: row('reminder', 'r1').status,
      pausedChase: row('reminder', 'r2').status,
      needsYou: row('reminder', 'r1').needsOwner,
      claim: row('taskClaim', 'cl1').status,
      teamUpdateClosed: row('teamUpdate', 'u1').closedAt !== null,
    }).toEqual({ task: 'dropped', chase: 'done', pausedChase: 'done', needsYou: false, claim: 'moot', teamUpdateClosed: true });
  });

  it('and it is never recorded as an achievement', async () => {
    const { tasks, row } = db();
    await tasks.setDropped('t1', 'not needed any more');
    expect(row('task', 't1').completedAt).toBeNull();
    expect(row('task', 't1').droppedReason).toBe('not needed any more');
  });

  it('re-opening it from the job page clears the ending', async () => {
    // `POST /tasks/:id/done {done:false}` — the button that would have been a silent no-op had it
    // gone through `PUT /tasks/:id` instead. (BEA-1315)
    const { tasks, row } = db();
    await tasks.setDropped('t1', 'Radha left');
    await tasks.setDone('t1', false);
    expect(row('task', 't1')).toMatchObject({ status: 'open', droppedAt: null, droppedReason: null });
  });

  it('and the ONE-OFF chase comes back too, not just the daily one', async () => {
    // This used to be the gap. Only `repeat: 'daily'` was revived, so a one-off chase stayed
    // stopped for ever: the job open again, sitting on somebody, nobody asking about it — the
    // original complaint pointing the other way. (BEA-1317)
    const { tasks, row } = db();
    await tasks.setDropped('t1', 'Radha left');
    await tasks.setDone('t1', false);
    expect(row('reminder', 'r2')).toMatchObject({ status: 'active', armedDay: null });
    expect(row('reminder', 'r2').repeat).not.toBe('daily'); // the kind that used to be left behind
  });
});

describe('re-opening never resurrects what the owner switched off (BEA-1317)', () => {
  // Reviving broadly is only safe because `done` has one author: the app, when the work ended.
  // These two are the proof of that claim rather than a restatement of it.
  it('a chase he STOPPED by hand stays stopped', async () => {
    const { tasks, store, row } = db();
    store.reminder.push({ id: 'byhand', taskId: 't1', status: 'stopped', repeat: 'none', needsOwner: false, pausedAuto: false });
    await tasks.setDone('t1', true);
    await tasks.setDone('t1', false);
    expect(row('reminder', 'byhand').status).toBe('stopped');
  });

  it('and one the app paused ITSELF is stopped, and does come back', async () => {
    // The pair to the test above. `pausedAuto: true` means the app paused it because somebody
    // claimed the work was finished — so ending the work may stop it, and re-opening (the owner
    // saying that claim was wrong) has to bring it back. (BEA-1293/1317)
    const { tasks, store, row } = db();
    store.reminder.push({ id: 'claimpaused', taskId: 't1', status: 'paused', repeat: 'none', needsOwner: false, pausedAuto: true });
    await tasks.setDone('t1', true);
    expect(row('reminder', 'claimpaused').status).toBe('done');
    await tasks.setDone('t1', false);
    expect(row('reminder', 'claimpaused').status).toBe('active');
  });
});

describe('re-opening runs it in reverse (BEA-1296)', () => {
  it('rejecting the claim puts the work AND the chase back', async () => {
    const { delegation, tasks, row } = db();
    await tasks.setDone('t1', true); // finished first, so there is something to undo
    await delegation.decideClaim('cl1', false, 'the videos are not up yet').catch(() => undefined);
    // The claim was already settled by the tick, so the reject is a no-op on it; the owner re-opens
    // the task itself, which is the path this asserts.
    await tasks.setDone('t1', false);
    expect(row('task', 't1').status).toBe('open');
    expect(row('reminder', 'r1').status).toBe('active');
  });

  it('a chase the OWNER paused by hand stays paused when the work re-opens', async () => {
    // `pausedAuto: false` means he made that call himself. Waking it would override a deliberate
    // decision with an automatic one. (BEA-1160)
    //
    // It now stays literally paused, where it used to be swept to `done` along with the rest and
    // left there. Both keep it silent, but only this one keeps the reason legible: `done` means
    // "the app stopped this because the work ended", and nothing else. That is exactly what makes
    // re-opening able to revive every `done` chase without ever resurrecting one of his. (BEA-1317)
    const { tasks, store, row } = db();
    store.reminder.push({ id: 'his', taskId: 't1', status: 'paused', repeat: 'none', needsOwner: false, pausedAuto: false });
    await tasks.setDone('t1', true);
    await tasks.setDone('t1', false);
    expect(row('reminder', 'his').status).toBe('paused'); // his call, untouched by either step
  });
});

describe('the one door is the only door (BEA-1296)', () => {
  it('the controllers do NOT pair up claim-decide and set-done by hand any more', () => {
    // The regression this guards: someone adds a fifth surface, copies the old two-line pairing,
    // forgets the second line, and the claim closes over a task that stays open and keeps chasing.
    const { readFileSync } = require('fs');
    const { join } = require('path');
    for (const f of ['tasks.controller.ts', '../contacts/reminders.controller.ts']) {
      const src = readFileSync(join(__dirname, f), 'utf8');
      expect(src).not.toMatch(/claims\.decide\(/);
    }
  });
});
