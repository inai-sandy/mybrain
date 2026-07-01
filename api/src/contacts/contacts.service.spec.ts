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
