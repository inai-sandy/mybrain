import { DelegationService } from './delegation.service';

/**
 * BEA-1308 — handing a job to somebody else.
 *
 * A job belonged to whoever it started with, for ever. Nothing anywhere ever changed a chase's
 * contact — I checked every `reminder.update`/`updateMany` in the codebase, and all of them use the
 * contact to FILTER, never to move one. So "reassigning" a task moved it on screen while the OLD
 * person kept getting the WhatsApp messages: the two halves disagreed by construction.
 *
 * That is why Radha's open work had nowhere to go when she left, and the only options were to
 * pretend it was finished or delete it.
 */

function db(over: any = {}) {
  const store: any = {
    task: { id: 't1', title: 'Work on the new production stock plan', kind: 'assignment', status: over.status || 'open', ownerContactId: 'radha' },
    handovers: [] as any[],
  };
  const state: any = { taskSaved: null, chases: null, claims: null, sendsCleared: false, handover: null, deletedHandover: null, newChase: null };
  const people: any = {
    radha: { id: 'radha', name: 'Radha', leftAt: over.fromLeft ? new Date() : null, whatsappNumber: '9190' },
    jayanth: { id: 'jayanth', name: 'Jayanth', leftAt: over.toLeft ? new Date() : null, whatsappNumber: '9191' },
    nonumber: { id: 'nonumber', name: 'Kishore', leftAt: null, whatsappNumber: null },
  };
  const prisma: any = {
    task: {
      // Stateful on purpose: the undo path hands the work BACK, which only makes sense if the first
      // handover actually moved it. A stub that ignored its own update made the undo look like a
      // no-op and the test fail for a reason that existed only in the stub.
      findUnique: async () => ('task' in over ? over.task : store.task),
      update: async ({ data }: any) => { state.taskSaved = data; Object.assign(store.task, data); return { ...store.task }; },
    },
    contact: { findUnique: async ({ where }: any) => people[where.id] ?? null },
    taskClaim: { updateMany: async (a: any) => { state.claims = a; return { count: over.claimCount ?? 0 }; } },
    reminder: {
      findFirst: async () => ('oldChase' in over ? over.oldChase : { id: 'r1', subject: 'the stock plan', message: 'Hi Radha…', count: 2, times: '["10:00","17:30"]', repeat: 'daily' }),
      updateMany: async (a: any) => { state.chases = a; return { count: over.chaseCount ?? 1 }; },
      create: async ({ data }: any) => { state.newChase = data; return { id: 'r2', ...data }; },
    },
    reminderSend: { deleteMany: async () => { state.sendsCleared = true; return { count: 0 }; } },
    taskHandover: {
      create: async ({ data }: any) => { state.handover = data; store.handovers.push(data); return { id: 'h1', ...data }; },
      findFirst: async () => (over.lastHandover === null ? null : over.lastHandover ?? { id: 'h1', taskId: 't1', fromContactId: 'radha', toContactId: 'jayanth' }),
      delete: async ({ where }: any) => { state.deletedHandover = where.id; return {}; },
    },
  };
  return { svc: new DelegationService(prisma, {} as any, {} as any), state, store };
}

describe('handing work to somebody else (BEA-1308)', () => {
  it('moves the work AND stops the old chase — the two halves finally agree', async () => {
    const { svc, state } = db();
    const res: any = await svc.handOver('t1', 'jayanth', 'Radha left');
    expect(state.taskSaved).toMatchObject({ ownerContactId: 'jayanth', party: 'Jayanth' });
    expect(state.chases.data).toEqual({ status: 'stopped' });
    expect(state.chases.where).toMatchObject({ taskId: 't1' });
    expect(res).toMatchObject({ from: 'Radha', to: 'Jayanth', stoppedChases: 1 });
  });

  it('clears anything already queued, so the old person hears nothing more', async () => {
    const { svc, state } = db();
    await svc.handOver('t1', 'jayanth');
    expect(state.sendsCleared).toBe(true);
  });

  it('records who had it before, so the chain survives', async () => {
    // Its own row rather than a "previous owner" column: work passing through three people should
    // remember all three. It is also the first real history this app keeps on a task.
    const { svc, state } = db();
    await svc.handOver('t1', 'jayanth', 'Radha left the organisation');
    expect(state.handover).toMatchObject({ taskId: 't1', fromContactId: 'radha', toContactId: 'jayanth', reason: 'Radha left the organisation' });
  });

  it('records a handover from the OWNER himself, with nobody before', async () => {
    const { svc, state } = db({ task: { id: 't1', title: 'x', kind: 'assignment', status: 'open', ownerContactId: null } });
    await svc.handOver('t1', 'jayanth');
    expect(state.handover.fromContactId).toBeNull();
  });

  it('settles the old person\'s claim rather than carrying it to somebody who never made it', async () => {
    // They said they had finished it. Handing the work on does not make that true, and does not make
    // it false — it stops being a question anyone can answer. Same as when work is dropped.
    const { svc, state } = db({ claimCount: 1 });
    const res: any = await svc.handOver('t1', 'jayanth');
    expect(state.claims.data.status).toBe('moot');
    expect(res.settledClaims).toBe(1);
  });

  it('refuses to hand work to somebody who has LEFT', async () => {
    const { svc, state } = db({ toLeft: true });
    await expect(svc.handOver('t1', 'jayanth')).rejects.toThrow(/has left/i);
    expect(state.taskSaved).toBeNull();
  });

  it('refuses work that has already ended — finished or dropped', async () => {
    for (const status of ['done', 'dropped']) {
      const { svc, state } = db({ status });
      await expect(svc.handOver('t1', 'jayanth')).rejects.toThrow(/already ended/i);
      expect(state.chases).toBeNull(); // and nothing is touched on the way out
    }
  });

  it('handing it to whoever already has it changes nothing', async () => {
    const { svc, state } = db();
    const res: any = await svc.handOver('t1', 'radha');
    expect(res.unchanged).toBe(true);
    expect(state.chases).toBeNull();
    expect(state.handover).toBeNull();
  });

  it('says plainly when the new person has no WhatsApp number', async () => {
    // Handing work to somebody unreachable is allowed — it is still their job — but the caller has
    // to know no chase can go out, rather than wondering why nothing happens.
    const { svc } = db();
    const res: any = await svc.handOver('t1', 'nonumber');
    expect(res.hasNumber).toBe(false);
  });

  it('a missing task or a stranger is a clear error, not a silent no-op', async () => {
    const missing = db({ task: null });
    await expect(missing.svc.handOver('gone', 'jayanth')).rejects.toThrow(/no longer exists/i);
    const stranger = db();
    await expect(stranger.svc.handOver('t1', 'nobody')).rejects.toThrow(/not in your contacts/i);
  });
});

describe('the new person actually gets chased (BEA-1308)', () => {
  /**
   * The half of this that was missing. Stopping the old chase and starting nothing meant the work
   * moved on screen and simply stopped being asked about — for ever, with nothing saying so. Worse
   * for a daily report: nothing in the app can revive a `stopped` chase, so a standing report would
   * have had to be rebuilt by hand. (review finding)
   */
  it('starts a chase for them, inheriting when and how often', async () => {
    const { svc, state } = db();
    const res: any = await svc.handOver('t1', 'jayanth');
    expect(state.newChase).toMatchObject({ contactId: 'jayanth', taskId: 't1', status: 'active', repeat: 'daily', times: '["10:00","17:30"]', count: 2 });
    expect(res.chasing).toBe(true);
  });

  it('and writes a message that reads as a HANDOVER, not an accusation', async () => {
    // They have never seen this work. "Where is this?" would be the app blaming somebody for
    // something they were handed thirty seconds ago.
    const { svc, state } = db();
    await svc.handOver('t1', 'jayanth');
    expect(state.newChase.message).toContain('Jayanth');
    expect(state.newChase.message).toMatch(/come over to you/i);
    expect(state.newChase.message).toContain('Radha'); // says where it came from
    expect(state.newChase.message).not.toMatch(/Hi Radha/); // never the old person's message reused
  });

  it('starts nothing when there was no chase to begin with', async () => {
    const { svc, state } = db({ oldChase: null });
    const res: any = await svc.handOver('t1', 'jayanth');
    expect(state.newChase).toBeNull();
    expect(res.chaseNotStarted).toBe(false); // nothing was lost, so nothing to warn about
  });

  it('says so plainly when it COULD not start one', async () => {
    // Handing work to somebody with no number is allowed — it is still their job — but silently
    // starting no chase would look like the handover half-failed.
    const { svc, state } = db();
    const res: any = await svc.handOver('t1', 'nonumber');
    expect(state.newChase).toBeNull();
    expect(res.chaseNotStarted).toBe(true);
    expect(res.hasNumber).toBe(false);
  });
});

describe('the screens offer it (BEA-1308)', () => {
  const { readFileSync } = require('fs');
  const { join } = require('path');
  const read = (p: string) => readFileSync(join(__dirname, '../../../web/src', p), 'utf8');

  it('Delegated has a "hand over" action on open work', () => {
    const page = read('pages/Delegated.tsx');
    expect(page).toContain('HandOverSheet');
    expect(page).toMatch(/label: 'Hand over'/);
    // Only on work that is still live — handing over something finished or dropped is meaningless.
    expect(page).toMatch(/isOpen\(r\) \? \{ label: 'Hand over'/);
  });

  it('the undo it PROMISES is actually reachable', () => {
    // The sheet said "You can undo this" and nothing in the app called hand-back — a promise made
    // to the owner that only a raw API call could keep. My own test asserted the words were there,
    // which is exactly the failure mode: the copy passed, the feature did not exist. (review finding)
    const page = read('pages/Delegated.tsx');
    expect(page).toContain('/hand-back');
    expect(page).toMatch(/undoHandOver/);
  });

  it('the sheet says what happens to BOTH people before it happens', () => {
    const sheet = read('ui/HandOverSheet.tsx');
    expect(sheet).toMatch(/stops being chased/i);
    expect(sheet).toMatch(/stays in the history/i);
    expect(sheet).toMatch(/undo/i);
  });

  it('and warns when the new person cannot be reached', () => {
    // Handing work to somebody with no WhatsApp number is allowed — it is still their job — but
    // silently sending nothing would look like the handover failed.
    expect(read('ui/HandOverSheet.tsx')).toMatch(/no WhatsApp number/i);
  });
});

describe('nobody is blamed for a day the work moved (BEA-1308)', () => {
  /**
   * The miss summary reads the owner at CLOSE time. So a report handed over this morning named the
   * NEW person for a day that was mostly not theirs — and, before a chase was started for them, for
   * a day they had never once been asked about. (review finding)
   */
  const { RecurringService } = require('./recurring.service');

  function closer(movedToday: string[]) {
    const marked: string[] = [];
    const prisma: any = {
      setting: {
        findUnique: async ({ where }: any) => (where.key === 'recurring.closedDay' ? null : { value: '18' }),
        upsert: async () => ({}),
      },
      task: {
        findMany: async () => [
          { id: 'daily1', title: 'Send the 3rd floor production update', scheduleDays: null, ownerContact: { name: 'Jayanth' } },
        ],
      },
      taskStatusDay: { findUnique: async () => null, create: async ({ data }: any) => { marked.push(data.taskId); return data; } },
      taskHandover: { findMany: async () => movedToday.map((taskId) => ({ taskId })) },
    };
    const svc: any = new RecurringService(prisma);
    svc.restDays = async () => [];
    svc.isReceived = async () => false;
    return { svc, marked };
  }

  // The clock is UTC and the app closes the day in IST, so an evening close is 13:00Z, not 18:30Z.
  // At 18:30Z it is already midnight IST and closeDay returns before doing anything — which made
  // the "not blamed" case pass for entirely the wrong reason until its positive pair failed.
  it('a report handed over TODAY is not marked missed against anyone', async () => {
    const { svc, marked } = closer(['daily1']);
    const res = await svc.closeDay(new Date('2026-08-14T13:00:00Z'));
    expect(marked).toEqual([]);
    expect(res).toBeNull(); // and nothing lands in the evening summary
  });

  it('but an ordinary missed report is still caught', async () => {
    const { svc, marked } = closer([]);
    const res: any = await svc.closeDay(new Date('2026-08-14T13:00:00Z'));
    expect(marked).toEqual(['daily1']);
    expect(res.missed[0].contact).toBe('Jayanth');
  });
});

describe('undoing a handover (BEA-1308)', () => {
  it('hands it straight back, and forgets the hop', async () => {
    // The real sequence, not a contrived starting state: hand it over, then undo. Setting up "the
    // handover says radha→jayanth but the task is still radha's" was a state the app can never be
    // in, and the test failed for that reason rather than for a real one.
    const { svc, state, store } = db();
    await svc.handOver('t1', 'jayanth', 'Radha left');
    expect(store.task.ownerContactId).toBe('jayanth');

    const res: any = await svc.undoHandOver('t1');
    expect(res.to).toBe('Radha');
    expect(store.task.ownerContactId).toBe('radha');
    expect(state.deletedHandover).toBe('h1');
  });

  it('does NOT rewrite history — the real reason survives', async () => {
    // Undo used to call handOver in reverse, which wrote a new row saying "handed back" and then
    // deleted the original. A single undo destroyed the reason the work moved ("Radha left the
    // organisation") and replaced it with a synthetic line — in the one table whose entire purpose
    // is that the chain survives. (review finding)
    const { svc, state } = db();
    await svc.handOver('t1', 'jayanth', 'Radha left the organisation');
    expect(state.handover.reason).toBe('Radha left the organisation');

    state.handover = null; // anything written from here is a NEW row
    await svc.undoHandOver('t1');
    expect(state.handover).toBeNull(); // undo writes nothing
    expect(state.deletedHandover).toBe('h1'); // it removes the hop, and only the hop
  });

  it('refuses to hand it back to somebody who has since left', async () => {
    const { svc } = db({ fromLeft: true });
    await expect(svc.undoHandOver('t1')).rejects.toThrow(/has left/i);
  });

  it('gives it back to the OWNER when it was his before', async () => {
    const { svc, state } = db({ lastHandover: { id: 'h1', taskId: 't1', fromContactId: null, toContactId: 'jayanth' } });
    const res: any = await svc.undoHandOver('t1');
    expect(res.to).toBeNull();
    expect(state.taskSaved).toMatchObject({ ownerContactId: null, party: null });
  });

  it('refuses when it was never handed over', async () => {
    const { svc } = db({ lastHandover: null });
    await expect(svc.undoHandOver('t1')).rejects.toThrow(/not been handed over/i);
  });
});
