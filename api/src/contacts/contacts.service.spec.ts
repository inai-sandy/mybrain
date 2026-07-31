import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContactsService } from './contacts.service';

function fakePrisma() {
  const rows: any[] = [];
  let n = 0;
  return {
    _rows: rows,
    contact: {
      create: async ({ data }: any) => { const r = { id: `c-${++n}`, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(r); return r; },
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) || null,
      findMany: async ({ where, take, skip }: any = {}) => {
        let out = rows.filter((r) => {
          if (!where?.OR) return true;
          return where.OR.some((c: any) => {
            const k = Object.keys(c)[0];
            const needle = c[k].contains;
            return (r[k] || '').includes(needle);
          });
        });
        out = [...out].sort((a, b) => a.name.localeCompare(b.name));
        if (skip) out = out.slice(skip);
        if (take) out = out.slice(0, take);
        return out;
      },
      count: async ({ where }: any = {}) => rows.filter((r) => (where?.OR ? where.OR.some((c: any) => { const k = Object.keys(c)[0]; return (r[k] || '').includes(c[k].contains); }) : true)).length,
      update: async ({ where, data }: any) => { const r = rows.find((x) => x.id === where.id); Object.assign(r, data); return r; },
      delete: async ({ where }: any) => { const i = rows.findIndex((x) => x.id === where.id); if (i < 0) throw new Error('not found'); return rows.splice(i, 1)[0]; },
    },
  } as any;
}

describe('ContactsService (BEA-719)', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let svc: ContactsService;
  beforeEach(() => { prisma = fakePrisma(); svc = new ContactsService(prisma as any); });

  it('creates a contact, normalising the WhatsApp number to digits', async () => {
    const c = await svc.create({ name: '  Ravi ', whatsappNumber: '+91 (98) 765-43210', tags: ['vendor'] });
    expect(c.name).toBe('Ravi');
    expect(c.whatsappNumber).toBe('919876543210');
    expect(c.tags).toEqual(['vendor']);
  });

  it('requires a name', async () => {
    await expect(svc.create({ name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blank number stays null', async () => {
    const c = await svc.create({ name: 'No Number' });
    expect(c.whatsappNumber).toBeNull();
  });

  it('lists with search + total', async () => {
    await svc.create({ name: 'Ravi', whatsappNumber: '91999' });
    await svc.create({ name: 'Sunil', notes: 'plumber' });
    const all = await svc.list();
    expect(all.total).toBe(2);
    expect(all.contacts[0].name).toBe('Ravi'); // sorted A-Z
    const found = await svc.list('plumber');
    expect(found.total).toBe(1);
    expect(found.contacts[0].name).toBe('Sunil');
  });

  it('updates + deletes', async () => {
    const c = await svc.create({ name: 'Temp' });
    const up = await svc.update(c.id, { whatsappNumber: '12345', notes: 'note' });
    expect(up.whatsappNumber).toBe('12345');
    await svc.remove(c.id);
    await expect(svc.get(c.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('findByName resolves a task party, case-insensitive', async () => {
    await svc.create({ name: 'Ravi Kumar', whatsappNumber: '91999' });
    expect((await svc.findByName('ravi kumar'))?.whatsappNumber).toBe('91999');
    expect(await svc.findByName('nobody')).toBeNull();
    expect(await svc.findByName('')).toBeNull();
  });
});

/**
 * BEA-1149. "Did today's update come in?" was answered on a different screen from the person it was
 * about — one of the four the owner was bouncing between. It is answered here now, and it says
 * WHERE the answer came from, because a tick on their own page is not them telling you. (BEA-1152)
 */
describe("a person's page answers today (BEA-1149)", () => {
  const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(day + 'T12:00:00Z').getUTCDay()];
  const other = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].filter((d) => d !== weekday)[0];

  function withReports(reports: any[]) {
    const p: any = fakePrisma();
    p.contact.findUnique = async () => ({ id: 'c1', name: 'Rakesh' });
    p.taskClaim = { count: async () => 0 };
    p.reminder = { count: async () => 1 };
    p.reminderMessage = { findFirst: async () => null };
    p.setting = { findUnique: async () => ({ value: JSON.stringify(['Sun']) }) };
    p.task = { findMany: async ({ where }: any) => (where?.kind === 'recurring' ? reports : []) };
    return new ContactsService(p);
  }

  it("shows a report due today, and what settled it", async () => {
    const svc = withReports([
      { id: 't1', title: 'Send the daily production update', scheduleDays: null, statusDays: [{ day, status: 'received', quote: 'OT 8 members', source: 'whatsapp', signalAt: new Date() }] },
    ]);
    const s: any = await svc.state('c1');
    expect(s.today.due).toHaveLength(1);
    expect(s.today.due[0]).toMatchObject({ status: 'received', quote: 'OT 8 members', source: 'whatsapp' });
    expect(s.today.counts).toEqual({ due: 1, received: 1 });
  });

  it("keeps a report that isn't due today out of the count", async () => {
    const svc = withReports([
      { id: 't1', title: 'Send the daily production update', scheduleDays: null, statusDays: [] },
      { id: 't2', title: 'Other-day report', scheduleDays: JSON.stringify([other]), statusDays: [] },
    ]);
    const s: any = await svc.state('c1');
    expect(s.today.due.map((r: any) => r.taskId)).toEqual(['t1']);
    expect(s.today.notDue.map((r: any) => r.taskId)).toEqual(['t2']);
    expect(s.today.counts.due).toBe(1);
  });

  it('says a tick on their page is a tick, not a message', async () => {
    const svc = withReports([
      { id: 't1', title: 'Send the daily production update', scheduleDays: null, statusDays: [{ day, status: 'received', quote: "Sent today's update", source: 'page', signalAt: new Date() }] },
    ]);
    const s: any = await svc.state('c1');
    expect(s.today.due[0].source).toBe('page');
  });

  it('a person with no standing reports still gets a clean answer', async () => {
    const svc = withReports([]);
    const s: any = await svc.state('c1');
    expect(s.today.due).toEqual([]);
    expect(s.today.counts).toEqual({ due: 0, received: 0 });
  });
});

/**
 * BEA-1156. BEA-1147 gave each standing report its own days and fixed the owner's board and the
 * chase — and never reached the page his team looks at. Live, on a Tuesday, Rakesh's link asked him
 * for Friday's, Wednesday's AND Monday's updates, all offering a "Send today's update" box.
 */
describe("the team's own page only asks for what's due (BEA-1156)", () => {
  const day = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = WD[new Date(day + 'T12:00:00Z').getUTCDay()];
  const other = WD.filter((d) => d !== today && d !== 'Sun')[0];

  function board(tasks: any[]) {
    const p: any = fakePrisma();
    p.contact.findUnique = async () => ({ id: 'c1', name: 'Rakesh', shareSlug: 'rakesh-6npa', shareEnabled: true });
    p.setting = { findUnique: async () => ({ value: JSON.stringify(['Sun']) }) };
    p.task = { findMany: async () => tasks };
    return new ContactsService(p).publicBoard('rakesh-6npa');
  }

  const report = (id: string, title: string, days: string[] | null) => ({
    id, title, note: null, status: 'open', dueDate: null, createdAt: new Date(), completedAt: null,
    promisedFor: null, kind: 'recurring', scheduleDays: days ? JSON.stringify(days) : null, claims: [], statusDays: [],
  });

  it("does not ask for another day's report", async () => {
    const b: any = await board([report('t1', 'Send the daily production update', null), report('t2', 'Other-day report', [other])]);
    expect(b.open.map((t: any) => t.id)).toEqual(['t1']);
  });

  // Uses `other` — a weekday that is definitely not today — rather than a hardcoded 'Fri'. The old
  // version failed every Friday: the board works in IST, so from 18:30 UTC the app's "today" is
  // already tomorrow, and a Friday report really was due. A test that only passes six days a week
  // is worse than no test, because it trains you to ignore a red suite.
  it('still shows it, under what is coming, with when it is due', async () => {
    const b: any = await board([report('t2', 'Send the production status update', [other])]);
    const notDue = b.reports.filter((r: any) => !r.dueToday);
    expect(notDue).toHaveLength(1);
    expect(notDue[0].schedule).toBe(other);
  });

  it('an ordinary job is never hidden by the schedule rule', async () => {
    const job = { id: 'j1', title: 'Discuss installation charges', note: null, status: 'open', dueDate: null, createdAt: new Date(), completedAt: null, promisedFor: null, kind: 'assignment', scheduleDays: null, claims: [], statusDays: [] };
    const b: any = await board([job]);
    expect(b.open.map((t: any) => t.id)).toEqual(['j1']);
  });

  it('a report with no days set is owed every working day', async () => {
    const b: any = await board([report('t1', 'Send the daily production update', null)]);
    expect(b.reports[0].dueToday).toBe(true);
    expect(b.reports[0].schedule).toBe('every working day');
  });
});

/**
 * BEA-1219: the contacts list is a TEAM BOARD — each card carries the work signals (open count,
 * needs-your-eyes, today's report state, chasing, last heard) folded from batched queries.
 */
describe('the team board (BEA-1219)', () => {
  const ALL_DAYS = '["Sun","Mon","Tue","Wed","Thu","Fri","Sat"]'; // always due — the test must not care what day it runs

  async function setup(opts: { statusDay?: string | null; recurringFor?: number[] } = {}) {
    const prisma = fakePrisma();
    const svc = new ContactsService(prisma as any);
    const a = await svc.create({ name: 'Jayanth' });
    const b = await svc.create({ name: 'Radha' });
    const recurringFor = opts.recurringFor ?? [0, 1];
    const ids = [a.id, b.id];
    prisma.task = {
      groupBy: async () => [{ ownerContactId: a.id, _count: { _all: 2 } }, { ownerContactId: b.id, _count: { _all: 1 } }],
      findMany: async () => recurringFor.map((i) => ({ id: `t${i}`, ownerContactId: ids[i], scheduleDays: ALL_DAYS })),
    };
    prisma.teamUpdate = { findMany: async () => [{ contactId: b.id }] };
    prisma.taskClaim = { findMany: async () => [] };
    prisma.reminder = { groupBy: async () => [{ contactId: a.id, _count: { _all: 1 } }] };
    prisma.reminderMessage = { groupBy: async () => [{ contactId: a.id, _max: { createdAt: '2026-07-30T10:00:00Z' } }] };
    prisma.taskStatusDay = { findMany: async () => (opts.statusDay === null ? [] : [{ taskId: 't0', status: opts.statusDay ?? 'received' }]) };
    prisma.setting = { findUnique: async () => null };
    return { svc, a, b };
  }

  it('folds every signal onto the right card', async () => {
    const { svc, a, b } = await setup();
    const out: any = await svc.board();
    const ja = out.contacts.find((c: any) => c.id === a.id).board;
    const ra = out.contacts.find((c: any) => c.id === b.id).board;
    expect(ja).toMatchObject({ open: 2, needsYou: 0, chasing: 1, report: 'in' });
    expect(ja.lastHeardAt).toBeTruthy();
    expect(ra).toMatchObject({ open: 1, needsYou: 1, chasing: 0, report: 'waiting', lastHeardAt: null });
  });

  it('one missed report colours the whole day missed', async () => {
    const { svc, a } = await setup({ statusDay: 'missed' });
    const out: any = await svc.board();
    expect(out.contacts.find((c: any) => c.id === a.id).board.report).toBe('missed');
  });

  it('no standing reports → no report signal at all', async () => {
    const { svc, a } = await setup({ recurringFor: [], statusDay: null });
    const out: any = await svc.board();
    expect(out.contacts.find((c: any) => c.id === a.id).board.report).toBeNull();
  });

  it('an empty page returns cleanly with no signal queries exploding', async () => {
    const prisma = fakePrisma();
    const svc = new ContactsService(prisma as any);
    const out: any = await svc.board('nobody-matches-this');
    expect(out.contacts).toEqual([]);
    expect(out.total).toBe(0);
  });
});
