import { TasksService } from './tasks.service';

/**
 * BEA-1188 — a brain-dump used to de-duplicate on the TITLE alone. Because the person lives in a
 * separate `who` field, two colleagues owing the same kind of report ("Send the daily production
 * update") looked like one task, and the second person's task was silently never created.
 */
function build(existingOpen: any[], crafted: any[], contacts: any[]) {
  const created: any[] = [];
  const prisma: any = {
    brainDump: { create: async () => ({ id: 'd1' }) },
    task: {
      findMany: async () => existingOpen,
      create: async ({ data }: any) => { const t = { id: 'n' + created.length, ...data }; created.push(t); return t; },
    },
    contact: { findMany: async () => contacts },
    setting: { findUnique: async () => null },
  };
  const svc: any = new TasksService(prisma, {} as any, {} as any, {} as any);
  svc.indexTask = () => undefined;
  svc.touchPerson = () => undefined;
  svc.allContacts = async () => contacts;
  svc.craft = async () => ({ tasks: crafted });
  svc.dayWindow = async () => ({ start: new Date(0), end: new Date() });
  svc.tz = async () => 'Asia/Kolkata';
  return { svc, created };
}

const jay = { id: 'c1', name: 'Jayanth', aliases: [] };
const kar = { id: 'c2', name: 'Karthik', aliases: [] };
const TITLE = 'Send the daily production update';

describe('a brain-dump de-duplicates per person (BEA-1188)', () => {
  it("still creates the task when someone ELSE already has one worded the same", async () => {
    const existing = [{ title: TITLE, ownerContactId: 'c1', party: 'Jayanth' }];
    const { svc, created } = build(existing, [{ title: TITLE, who: 'Karthik' }], [jay, kar]);
    const out = await svc.dump('...');
    expect(created.length).toBe(1);
    expect(created[0].ownerContactId).toBe('c2'); // Karthik's task exists, linked to him
    expect(out.tasks.length).toBe(1);
  });

  it('still skips a genuine repeat for the SAME person', async () => {
    const existing = [{ title: TITLE, ownerContactId: 'c1', party: 'Jayanth' }];
    const { svc, created } = build(existing, [{ title: TITLE, who: 'Jayanth' }], [jay, kar]);
    await svc.dump('...');
    expect(created.length).toBe(0);
  });

  it("still skips a repeat of the owner's own task", async () => {
    const existing = [{ title: 'Call the bank', ownerContactId: null, party: null }];
    const { svc, created } = build(existing, [{ title: 'Call the bank' }], [jay]);
    await svc.dump('...');
    expect(created.length).toBe(0);
  });

  it('does not let one dump create the same task twice for the same person', async () => {
    const { svc, created } = build([], [{ title: TITLE, who: 'Jayanth' }, { title: TITLE, who: 'Jayanth' }], [jay]);
    await svc.dump('...');
    expect(created.length).toBe(1);
  });

  it('DOES create one each when the same wording is dumped for two people at once', async () => {
    const { svc, created } = build([], [{ title: TITLE, who: 'Jayanth' }, { title: TITLE, who: 'Karthik' }], [jay, kar]);
    await svc.dump('...');
    expect(created.length).toBe(2);
    expect(created.map((t) => t.ownerContactId).sort()).toEqual(['c1', 'c2']);
  });
});
