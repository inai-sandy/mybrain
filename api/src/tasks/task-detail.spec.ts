import { readFileSync } from 'fs';
import { join } from 'path';
import { TasksService } from './tasks.service';

/**
 * BEA-1310 — one page per job, showing everything about it.
 *
 * The owner: *"Tasks, contacts, reminders, delegated tasks, chats: all these have to have a proper
 * connection."* They were connected in the database and nowhere on screen — there was no page for a
 * job at all. Answering "what is going on with the Elleys PCBs?" meant opening Delegated for the
 * chase, Chats for the conversation and the review list for the claim, and joining them in his head.
 *
 * Nothing here is new. The chase, the claims, the handovers, the day ledger and the messages have
 * been recorded for months; they had never been put in one place.
 */

/** Enough of Prisma's `where` for these mocks to actually filter, so a filter added to the real
 *  query changes what a test sees. */
function matchesWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where || {})) {
    if (k === 'taskId') continue; // every row in a test belongs to the task under test
    if (v && typeof v === 'object') {
      if ('not' in (v as any) && row[k] === (v as any).not) return false;
      if ('in' in (v as any) && !(v as any).in.includes(row[k])) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

function svc(over: any = {}) {
  const task =
    'task' in over
      ? over.task
      : {
          id: 't1',
          title: 'Place PCBs for the Elleys order',
          status: 'open',
          kind: 'assignment',
          createdAt: new Date('2026-08-01T09:00:00Z'),
          ownerContactId: 'deepthi',
          ownerContact: { id: 'deepthi', name: 'Deepthi' },
          people: [],
          claims: [],
          chases: over.chases ?? [{ id: 'r1', status: 'active', repeat: 'daily', times: '["10:00","17:30"]', subject: 'the Elleys PCBs', createdAt: new Date(), contact: { id: 'deepthi', name: 'Deepthi' } }],
        };
  const seen: any = {};
  const prisma: any = {
    task: { findUnique: async () => task },
    // Honours the `where` it is handed, rather than echoing the rows back regardless.
    // It used to ignore it entirely, so the "shows EVERY claim, including moot" test below passed
    // whether or not the code filtered them out — the exact shape of test that proves nothing.
    // (review finding)
    taskClaim: { findMany: async ({ where }: any) => (over.claims ?? []).filter((r: any) => matchesWhere(r, where)) },
    taskHandover: { findMany: async () => over.handovers ?? [] },
    taskStatusDay: { findMany: async () => over.days ?? [] },
    contact: { findMany: async ({ where }: any) => { seen.nameLookup = where; return over.people ?? [{ id: 'deepthi', name: 'Deepthi' }, { id: 'radha', name: 'Radha' }]; } },
    reminderMessage: { findMany: async ({ where, take }: any) => { seen.msgWhere = where; seen.msgTake = take; return over.messages ?? []; } },
  };
  // The REAL `shape()`, not a hand-written stand-in.
  //
  // My first version replaced it with `(x) => ({ ...x, owner: x.ownerContact })`, which is exactly
  // where the bug lived: `shape()` never returned `droppedAt`/`droppedReason`, so a dropped job's
  // story stopped dead with no closing line. Every test here passed, and would have kept passing
  // for ever, because I had stubbed out the method under test. (review finding)
  const s: any = new TasksService(prisma, {} as any, {} as any, {} as any);
  return { svc: s as TasksService, seen };
}

describe('the whole picture of one job (BEA-1310)', () => {
  it('brings the chase, the claims, the handovers and the conversation together', async () => {
    const { svc: s } = svc({
      claims: [{ id: 'c1', quote: 'placed today sir', status: 'confirmed', source: 'whatsapp', createdAt: new Date(), decidedAt: new Date(), contact: { id: 'deepthi', name: 'Deepthi' } }],
      handovers: [{ id: 'h1', fromContactId: 'radha', toContactId: 'deepthi', reason: 'Radha left', at: new Date() }],
      messages: [{ id: 'm1', direction: 'in', body: 'placed today sir', createdAt: new Date(), contactId: 'deepthi' }],
    });
    const d: any = await (s as any).detail('t1');
    expect(d.title).toContain('Elleys');
    expect(d.chases).toHaveLength(1);
    expect(d.claims[0].by).toBe('Deepthi');
    expect(d.handovers[0]).toMatchObject({ from: 'Radha', to: 'Deepthi' });
    expect(d.messages[0].body).toBe('placed today sir');
  });

  it('turns the chase times back into a list, not the stored JSON', async () => {
    const { svc: s } = svc();
    const d: any = await (s as any).detail('t1');
    expect(d.chases[0].times).toEqual(['10:00', '17:30']);
  });

  it('shows EVERY claim, including ones settled as moot', async () => {
    // A claim mooted when work was dropped or handed on is invisible everywhere else — the review
    // list only holds pending ones. This page is the only place that story is whole.
    const { svc: s } = svc({
      claims: [
        { id: 'c1', quote: 'I did it', status: 'moot', source: 'whatsapp', createdAt: new Date(), decidedAt: new Date(), contact: { id: 'radha', name: 'Radha' } },
      ],
    });
    const d: any = await (s as any).detail('t1');
    expect(d.claims).toHaveLength(1);
    expect(d.claims[0].status).toBe('moot');
  });

  it('survives a name that no longer resolves, because history outlives contacts', async () => {
    // Handover ids deliberately have no foreign key so the chain survives a contact being deleted.
    // A missing name is a real outcome, not a bug, and must not read as blank.
    const { svc: s } = svc({
      handovers: [{ id: 'h1', fromContactId: 'ghost', toContactId: 'deepthi', at: new Date() }],
      people: [{ id: 'deepthi', name: 'Deepthi' }],
    });
    const d: any = await (s as any).detail('t1');
    expect(d.handovers[0].from).toMatch(/since removed/i);
    expect(d.handovers[0].to).toBe('Deepthi');
  });

  it('a daily report carries its day-by-day ledger; a one-off does not', async () => {
    const daily = svc({
      task: { id: 't2', title: 'Send the daily production update', status: 'open', kind: 'recurring', createdAt: new Date(), ownerContactId: 'deepthi', ownerContact: { id: 'deepthi', name: 'Deepthi' }, people: [], claims: [], chases: [] },
      days: [{ day: '2026-08-13', status: 'received', quote: '240 units', summary: null, contactId: 'deepthi', source: 'whatsapp' }],
    });
    const d: any = await (daily.svc as any).detail('t2');
    expect(d.days).toHaveLength(1);
    expect(d.days[0].by).toBe('Deepthi');

    const oneOff = svc();
    expect((await (oneOff.svc as any).detail('t1')).days).toEqual([]);
  });

  it('reads ONLY what was said about this work, and caps it', async () => {
    // It used to widen to every message from the person who owns it. On the live page for "Confirm
    // the payment amount", that showed a conversation about placing PCBs for the Elleys order —
    // under a heading saying "What was said". Caught by looking at the actual page. (self-caught)
    const { svc: s, seen } = svc();
    await (s as any).detail('t1');
    expect(seen.msgTake).toBe(8); // exactly what the page shows, not 40 to render 8
    expect(JSON.stringify(seen.msgWhere)).toContain('reminderId');
    expect(JSON.stringify(seen.msgWhere)).not.toContain('contactId');
  });

  it('asks for no messages at all when the job has never been chased', async () => {
    const { svc: s, seen } = svc({ chases: [] });
    const d: any = await (s as any).detail('t1');
    expect(d.messages).toEqual([]);
    expect(seen.msgWhere).toBeUndefined(); // and does not go looking
  });

  it('a DROPPED job says how it ended — when, and why', async () => {
    // The story used to stop dead: no closing line, no reason, for every dropped job on the page.
    const { svc: s } = svc({
      task: {
        id: 't1', title: 'Work on the new production stock plan', status: 'dropped', kind: 'assignment',
        createdAt: new Date('2026-08-01T09:00:00Z'), droppedAt: new Date('2026-08-14T16:00:00Z'),
        droppedReason: 'Radha left the organisation', tags: null,
        ownerContactId: 'radha', ownerContact: { id: 'radha', name: 'Radha' }, people: [], claims: [], chases: [],
      },
    });
    const d: any = await (s as any).detail('t1');
    expect(d.status).toBe('dropped');
    expect(d.droppedReason).toBe('Radha left the organisation');
    expect(d.droppedAt).toBeInstanceOf(Date);
  });

  it('and a job that is merely open carries no ending at all', async () => {
    const { svc: s } = svc();
    const d: any = await (s as any).detail('t1');
    expect(d.droppedAt).toBeNull();
    expect(d.droppedReason).toBeNull();
  });

  it('names whoever sent each message, even with no handover to borrow a name from', async () => {
    // The name lookup was built from handover and day-ledger ids only, so an inbound message
    // resolved to "someone since removed" in the ordinary case. It hid behind the one test that
    // had a handover — whose contact happened to be the same person. (review finding)
    const { svc: s } = svc({
      messages: [{ id: 'm1', direction: 'in', body: 'placed today sir', createdAt: new Date(), contactId: 'deepthi' }],
    });
    const d: any = await (s as any).detail('t1');
    expect(d.messages[0].by).toBe('Deepthi');
    expect(d.messages[0].by).not.toMatch(/since removed/i);
  });

  it('and says nothing about who sent the ones we sent', async () => {
    const { svc: s } = svc({
      messages: [{ id: 'm1', direction: 'out', body: 'any update?', createdAt: new Date(), contactId: 'deepthi' }],
    });
    expect((await (s as any).detail('t1')).messages[0].by).toBeNull();
  });

  it('a job that is gone returns nothing rather than half a page', async () => {
    const { svc: s } = svc({ task: null });
    expect(await (s as any).detail('gone')).toBeNull();
  });

  it('never asks for names when there are none to ask about', async () => {
    const { svc: s, seen } = svc();
    await (s as any).detail('t1');
    expect(seen.nameLookup).toBeUndefined();
  });
});

describe('the job is reachable, and the routes still work (BEA-1310)', () => {
  it('the task list and the person\'s work both link through to it', () => {
    // The audit's finding: nothing on a task card led anywhere, so the chase, the conversation and
    // the claims had to be joined up in the owner's head across three screens.
    const card = readFileSync(join(__dirname, '../../../web/src/pages/taskShared.tsx'), 'utf8');
    expect(card).toMatch(/to=\{`\/tasks\/\$\{t\.id\}`\}/);
    const work = readFileSync(join(__dirname, '../../../web/src/ui/ContactWork.tsx'), 'utf8');
    expect(work).toMatch(/to=\{`\/tasks\/\$\{r\.id\}`\}/);
  });

  it('Today links through too — the most-viewed screen of the five', () => {
    // The first pass wired three of five surfaces and left Today, which he opens every morning.
    // Tapping the row still opens Edit; the way through is its own control, so nothing changes
    // underfoot and a link is never nested inside a button. (review finding)
    const today = readFileSync(join(__dirname, '../../../web/src/pages/Today.tsx'), 'utf8');
    expect(today).toMatch(/to=\{`\/tasks\/\$\{t\.id\}`\}/);
    expect(today).toMatch(/Everything about/);
  });

  it('but the day-close review deliberately does NOT, and says why', () => {
    // Nothing on that screen is saved until the close is submitted, so a link through would throw
    // away the whole night's review. Four of five surfaces link; this one is a considered no, and
    // this test exists so it is not "fixed" by a later pass that only counts links.
    const close = readFileSync(join(__dirname, '../../../web/src/pages/CloseDay.tsx'), 'utf8');
    expect(close).not.toMatch(/to=\{`\/tasks\/\$\{t\.id\}`\}/);
    expect(close).toMatch(/Deliberately NOT a link through/);
  });

  it('and a chase in the chat leads back to the job it is about', () => {
    // The ticket asks for it to be reachable "from a chat message". A chase card named its job in
    // plain grey text — "re: Place PCBs for the Elleys order" — and led nowhere, so the one
    // direction missing was message → work.
    const chat = readFileSync(join(__dirname, '../../../web/src/pages/Contacts.tsx'), 'utf8');
    expect(chat).toMatch(/to=\{`\/tasks\/\$\{rm\.task\.id\}`\}/);
  });

  it('the page is routed', () => {
    const app = readFileSync(join(__dirname, '../../../web/src/App.tsx'), 'utf8');
    expect(app).toMatch(/path="tasks\/:id"/);
  });

  it('`:id` is declared LAST, so it cannot swallow a static route', () => {
    // `/tasks/health`, `/tasks/model`, `/tasks/delegated` and the rest are all one segment, exactly
    // like a task id. Nest matches in declaration order, so a `:id` route placed above them would
    // quietly turn every one of those screens into "no such task".
    const src = readFileSync(join(__dirname, 'tasks.controller.ts'), 'utf8');
    const detailAt = src.indexOf("@Get(':id')");
    expect(detailAt).toBeGreaterThan(-1);
    for (const route of ["@Get('delegated')", "@Get('stalling')", "@Get('claims')", "@Get('health')", "@Get('brain-eaters')", "@Get('settings')", "@Get('models')", "@Get('model')", "@Get('by-person')", "@Get('today')"]) {
      expect({ route, before: src.indexOf(route) < detailAt }).toEqual({ route, before: true });
    }
  });
});
