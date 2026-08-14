import { readFileSync } from 'fs';
import { join } from 'path';
import { TasksService } from './tasks.service';
import { TASK_OPEN, TASK_DONE, TASK_DROPPED, isOpen, isDone, isDropped, isClosed, normaliseStatus, OPEN_WORK } from './task-status';

/**
 * BEA-1306 — not every job that ends was finished.
 *
 * A task was only ever `open` or `done`, so when work ended without being finished the app made you
 * lie: mark it done, and it counts in the finished numbers and the person is thanked for completing
 * it; or delete it, and the record goes too.
 *
 * It came up the day Radha left the organisation with two jobs open. They were not done. They were
 * not hers. There was nothing to close them as.
 */

describe('the three states (BEA-1306)', () => {
  it('dropped is not done — the distinction the whole ticket rests on', () => {
    expect(isDone({ status: TASK_DROPPED })).toBe(false);
    expect(isDropped({ status: TASK_DROPPED })).toBe(true);
    expect(isClosed({ status: TASK_DROPPED })).toBe(true); // ended, either way
    expect(isClosed({ status: TASK_DONE })).toBe(true);
  });

  it('dropped is not open either — it stops being owed', () => {
    expect(isOpen({ status: TASK_DROPPED })).toBe(false);
    expect(isOpen({ status: TASK_OPEN })).toBe(true);
  });

  it('asks for open work by NAME, never as "not done"', () => {
    // The trap: with two states those meant the same thing, and with three they do not. Written as
    // an equality test so a fourth state added later is excluded until somebody decides it counts —
    // a missing row on a screen is a smaller failure than chasing a real person about work nobody
    // expects any more.
    expect(OPEN_WORK).toEqual({ status: 'open' });
  });

  it('a stray value never becomes a fourth state', () => {
    expect(normaliseStatus('DONE')).toBe(TASK_DONE);
    expect(normaliseStatus('nonsense')).toBe(TASK_OPEN);
    expect(normaliseStatus(undefined)).toBe(TASK_OPEN);
  });
});

// ---- dropping a task ----
function svc(task: any = { id: 't1', title: 'Work on the new production stock plan', status: 'open', progress: 40, ownerContactId: 'radha' }) {
  const state: any = { saved: null, chases: [] };
  const prisma: any = {
    task: {
      findUnique: async () => task,
      update: async ({ data }: any) => { state.saved = data; return { ...task, ...data }; },
    },
    reminder: { updateMany: async (a: any) => { state.chases.push(a); return { count: 1 }; } },
    reminderSend: { deleteMany: async () => ({ count: 0 }) },
    taskClaim: { updateMany: async () => ({ count: 0 }) },
    teamUpdate: { updateMany: async () => ({ count: 0 }) },
  };
  const s: any = new TasksService(prisma, {} as any, {} as any, {} as any);
  s.indexTask = () => undefined;
  s.touchPerson = () => undefined;
  s.shape = (x: any) => x;
  return { svc: s as TasksService, state };
}

describe('dropping a task (BEA-1306)', () => {
  it('records it as dropped, with when and why', async () => {
    const { svc: s, state } = svc();
    await (s as any).setDropped('t1', 'Radha left the organisation');
    expect(state.saved.status).toBe(TASK_DROPPED);
    expect(state.saved.droppedReason).toBe('Radha left the organisation');
    expect(state.saved.droppedAt).toBeInstanceOf(Date);
  });

  it('NEVER stamps completedAt — that is what every report counts as finished work', async () => {
    // Recording a drop as a completion would credit the person with finishing something they never
    // did, and inflate the day's done-count. This is the whole point of a third state.
    const { svc: s, state } = svc();
    await (s as any).setDropped('t1', 'called off');
    expect(state.saved.completedAt).toBeNull();
    expect(state.saved.progress).toBeUndefined(); // and never forced to 100
  });

  it('ends it properly — the chase stops, through the same one door as finishing', async () => {
    const { svc: s, state } = svc();
    await (s as any).setDropped('t1', 'x');
    const stop = state.chases.find((c: any) => c.data?.status === 'done');
    expect(stop).toBeTruthy();
    expect(stop.where).toMatchObject({ taskId: 't1' });
  });

  it('dropping twice does not restamp the date', async () => {
    const { svc: s, state } = svc({ id: 't1', title: 'x', status: TASK_DROPPED, droppedAt: new Date('2020-01-01') });
    await (s as any).setDropped('t1', 'again');
    expect(state.saved).toBeNull(); // nothing written at all
  });

  it('a missing task is not an error worth throwing at anyone', async () => {
    const { svc: s } = svc(null);
    expect(await (s as any).setDropped('gone', 'x')).toBeNull();
  });

  it('re-opening a dropped task clears the drop — it cannot be both', async () => {
    const { svc: s, state } = svc({ id: 't1', title: 'x', status: TASK_DROPPED, droppedAt: new Date(), droppedReason: 'was called off' });
    await s.setDone('t1', false);
    expect(state.saved.status).toBe(TASK_OPEN);
    expect(state.saved.droppedAt).toBeNull();
    expect(state.saved.droppedReason).toBeNull();
  });

  it('finishing a task does NOT clear a drop reason it never had', async () => {
    const { svc: s, state } = svc();
    await s.setDone('t1', true);
    expect(state.saved.status).toBe(TASK_DONE);
    expect(state.saved.droppedAt).toBeUndefined(); // untouched, not nulled
  });
});

describe('a claim waiting on you when the work is dropped (BEA-1306)', () => {
  /**
   * They said they finished it. The owner then drops the work. What is recorded?
   *
   * Not **confirmed** — that means "yes, you finished it", about work just recorded as NOT done.
   * Not **rejected** — that means "no, you didn't", and nobody decided that either. The question
   * simply stopped needing an answer, so it leaves the review list without a verdict being invented
   * on the person's behalf. (review finding)
   */
  function claimDb(dropped: boolean) {
    const claims: any = { updates: [] };
    const prisma: any = {
      reminder: { updateMany: async () => ({ count: 0 }) },
      reminderSend: { deleteMany: async () => ({ count: 0 }) },
      taskClaim: { updateMany: async (a: any) => { claims.updates.push(a); return { count: 1 }; } },
      teamUpdate: { updateMany: async () => ({ count: 0 }) },
    };
    return { prisma, claims, dropped };
  }

  it('is settled as moot, not confirmed', async () => {
    const { settleDelegation } = require('./delegation');
    const { prisma, claims } = claimDb(true);
    await settleDelegation(prisma, 't1', true, undefined, 'dropped');
    const c = claims.updates.find((u: any) => u.where?.status === 'pending');
    expect(c.data.status).toBe('moot');
  });

  it('but finishing the work still CONFIRMS it — that has not changed', async () => {
    const { settleDelegation } = require('./delegation');
    const { prisma, claims } = claimDb(false);
    await settleDelegation(prisma, 't1', true, undefined, 'done');
    const c = claims.updates.find((u: any) => u.where?.status === 'pending');
    expect(c.data.status).toBe('confirmed');
  });

  it('defaults to confirmed when nobody says how it ended — the old behaviour', async () => {
    const { settleDelegation } = require('./delegation');
    const { prisma, claims } = claimDb(false);
    await settleDelegation(prisma, 't1', true);
    expect(claims.updates.find((u: any) => u.where?.status === 'pending').data.status).toBe('confirmed');
  });

  it('either way it leaves the review list — it is decided', async () => {
    const { settleDelegation } = require('./delegation');
    for (const how of ['done', 'dropped'] as const) {
      const { prisma, claims } = claimDb(how === 'dropped');
      await settleDelegation(prisma, 't1', true, undefined, how);
      const c = claims.updates.find((u: any) => u.where?.status === 'pending');
      expect(c.data.decidedAt).toBeInstanceOf(Date);
      expect(c.data.status).not.toBe('pending');
    }
  });
});

describe('nothing still asks for open work the old way (BEA-1306)', () => {
  /**
   * The sweep that made this safe: 37 places wrote `status: { not: 'done' }` meaning "still owed".
   * That was true with two states and false with three — every one of them would have counted
   * dropped work as still owed, and chased a real person about it.
   *
   * This guards the sweep. A new one written the old way is caught here rather than by somebody
   * getting a WhatsApp message about work that was called off weeks ago.
   */
  const SRC = join(__dirname, '..');
  const files = (dir: string): string[] => {
    const { readdirSync, statSync } = require('fs');
    return readdirSync(dir).flatMap((f: string) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return f === 'node_modules' ? [] : files(p);
      return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
    });
  };

  it('no production file asks for tasks with "not: done"', () => {
    const offenders = files(SRC)
      .filter((p) => !p.endsWith('task-status.ts'))
      .filter((p) => readFileSync(p, 'utf8').includes("status: { not: 'done' }"))
      .map((p: string) => p.replace(SRC, ''));
    expect(offenders).toEqual([]);
  });

  it('nothing works out "open" by SUBTRACTION either', () => {
    // The narrower lesson. My first version of this guard only matched one phrasing, and its
    // docstring claimed more than it checked — two violations were sitting in the same change:
    // `tasks.length - open.length` in the contact's state (counting dropped work as FINISHED on the
    // page about how a person stands) and `dayTasks.length - done.length` in the daily stats.
    // Arithmetic on totals is the same assumption as `not: 'done'`, wearing different clothes.
    const suspicious = /\.length\s*-\s*\w*(open|done)\w*\.length/i;
    const offenders = files(SRC)
      .filter((p: string) => suspicious.test(readFileSync(p, 'utf8')))
      .map((p: string) => p.replace(SRC, ''));
    expect(offenders).toEqual([]);
  });

  it('no production file compares a TASK status against done in memory', () => {
    // Flow runs legitimately use that phrasing for their own statuses (done | failed | cancelled),
    // so they are named here rather than the check being weakened to nothing.
    const ALLOWED = ['/flows/flows-runner.service.ts'];
    const offenders = files(SRC)
      .filter((p) => !p.endsWith('task-status.ts'))
      .filter((p) => /\.status !== 'done'/.test(readFileSync(p, 'utf8')))
      .map((p: string) => p.replace(SRC, ''))
      .filter((p: string) => !ALLOWED.includes(p));
    expect(offenders).toEqual([]);
  });
});

describe('the SCREENS know about the third state too (BEA-1306)', () => {
  /**
   * The API sweep alone was not enough, and this is the gap that mattered most: the web read
   * `status !== 'done'` as "open" in a dozen places, so a dropped task showed as open, counted as
   * open, and — worst — tapping its tick posted `{ done: true }` and recorded it as FINISHED. The
   * lie the whole change removes, put straight back by the screens.
   */
  const WEB = join(__dirname, '../../../web/src');
  const read = (p: string) => readFileSync(join(WEB, p), 'utf8');

  it('a tick never completes DROPPED work — it reopens it', () => {
    for (const f of ['pages/Delegated.tsx', 'ui/ContactWork.tsx']) {
      expect(read(f)).toContain('tickMeans');
      expect(read(f)).not.toMatch(/done: \w+\.status !== 'done'/);
    }
  });

  it('a dropped task is shown as "not done", never as finished and never as open', () => {
    const cw = read('ui/ContactWork.tsx');
    expect(cw).toMatch(/isDropped\(r\) \? 'not done'/);
    const card = read('pages/taskShared.tsx');
    expect(card).toMatch(/not done/);
    expect(card).toContain("t.status === 'dropped'");
  });

  it('the task card offers "not doing this", and only while the work is live', () => {
    const card = read('pages/taskShared.tsx');
    expect(card).toMatch(/onDrop && !closed/);
  });
});

describe('the nightly close no longer destroys work (BEA-1306)', () => {
  it('"not doing this" drops the task instead of deleting the row', () => {
    // It ran `task.delete()`. Every night, one tap from the tick box, the owner could permanently
    // destroy a task — the work, its chase, its claims, and the record it ever existed — because
    // there was no third state to move it to.
    const src = readFileSync(join(__dirname, '../daily/daily.service.ts'), 'utf8');
    const block = src.slice(src.indexOf('for (const id of (drop || [])'), src.indexOf('for (const id of (drop || [])') + 700);
    expect(block).toContain('setDropped');
    // The CALL, not the word — the comment above the code explains what it used to be, and a plain
    // substring check matched that explanation and failed for the wrong reason.
    expect(block).not.toMatch(/prisma\.task\.delete\(/);
    expect(block).not.toMatch(/await this\.prisma\.task\.delete/);
  });

  it('and the button no longer says "Delete for good"', () => {
    const page = readFileSync(join(__dirname, '../../../web/src/pages/CloseDay.tsx'), 'utf8');
    expect(page).not.toContain('Delete for good');
    expect(page).toContain('Not doing this');
    expect(page).toMatch(/stays in your history/i);
  });
});
