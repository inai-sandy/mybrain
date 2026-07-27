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
      { id: 't1', title: 'Send the daily production update', scheduleDays: null, statusDays: [{ status: 'received', quote: 'OT 8 members', source: 'whatsapp', signalAt: new Date() }] },
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
      { id: 't1', title: 'Send the daily production update', scheduleDays: null, statusDays: [{ status: 'received', quote: "Sent today's update", source: 'page', signalAt: new Date() }] },
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
