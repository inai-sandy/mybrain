import { TasksService } from './tasks.service';

/**
 * The party→contact backfill runs once against the owner's REAL tasks, so it gets its own tests.
 * The rule it must never break: link only on an exact, unique match; leave everything else
 * untouched and reportable. (BEA-1019)
 */
function makeService(contacts: any[], tasks: any[]) {
  const settings: Record<string, string> = {};
  const links: { taskId: string; contactId: string }[] = [];
  const prisma: any = {
    contact: { findMany: async () => contacts },
    setting: {
      findUnique: async ({ where }: any) => (settings[where.key] ? { key: where.key, value: settings[where.key] } : null),
      upsert: async ({ where, create, update }: any) => {
        settings[where.key] = update?.value ?? create.value;
        return { key: where.key, value: settings[where.key] };
      },
    },
    task: {
      findMany: async ({ where }: any = {}) =>
        tasks.filter((t) => {
          if (where?.ownerContactId === null && t.ownerContactId) return false;
          if (where?.NOT?.party === null && (t.party === null || t.party === undefined)) return false;
          return true;
        }),
      update: async ({ where, data }: any) => {
        const t = tasks.find((x) => x.id === where.id);
        Object.assign(t, data);
        return t;
      },
    },
    taskPerson: {
      findMany: async ({ where }: any) => links.filter((l) => l.taskId === where.taskId),
      create: async ({ data }: any) => { links.push(data); return data; },
      deleteMany: async ({ where }: any) => {
        for (let i = links.length - 1; i >= 0; i--) {
          if (links[i].taskId === where.taskId && where.contactId.in.includes(links[i].contactId)) links.splice(i, 1);
        }
        return { count: 0 };
      },
    },
  };
  const memory: any = { indexEntity: async () => undefined, deleteDoc: async () => undefined };
  return { svc: new TasksService(prisma, {} as any, {} as any, memory) as any, tasks, links };
}

const CONTACTS = [
  { id: 'c1', name: 'Srikar', aliases: '[]' },
  { id: 'c2', name: 'Vijaya Durga', aliases: '["Vijay Durga"]' },
  { id: 'c3', name: 'Dharmendra', aliases: '[]' },
  { id: 'c4', name: 'Dharmendra', aliases: '[]' }, // a real namesake — must NOT be guessed between
];

describe('linkExistingParties — the one-time backfill (BEA-1019)', () => {
  it('links a name that matches exactly one contact', async () => {
    const { svc, tasks } = makeService(CONTACTS, [{ id: 't1', party: 'Srikar', ownerContactId: null }]);
    const r = await svc.linkExistingParties();
    expect(r.linked).toBe(1);
    expect(tasks[0].ownerContactId).toBe('c1');
  });

  it('links through an alias — "Vijay Durga" is Vijaya Durga', async () => {
    const { svc, tasks } = makeService(CONTACTS, [{ id: 't1', party: 'Vijay Durga', ownerContactId: null }]);
    await svc.linkExistingParties();
    expect(tasks[0].ownerContactId).toBe('c2');
    expect(tasks[0].party).toBe('Vijaya Durga'); // display text follows the contact
  });

  it('REFUSES to pick between two people with the same name, and leaves the task alone', async () => {
    const { svc, tasks } = makeService(CONTACTS, [{ id: 't1', party: 'Dharmendra', ownerContactId: null }]);
    const r = await svc.linkExistingParties();
    expect(r.linked).toBe(0);
    expect(tasks[0].ownerContactId).toBeNull();
    expect(tasks[0].party).toBe('Dharmendra'); // nothing rewritten
    expect(r.unmatched[0]).toMatchObject({ party: 'Dharmendra', reason: '2 contacts share this name', taskIds: ['t1'] });
  });

  it('does NOT fuzzy-match a name that is close but not exact', async () => {
    const { svc, tasks } = makeService(CONTACTS, [{ id: 't1', party: 'Shrikar', ownerContactId: null }]);
    const r = await svc.linkExistingParties();
    expect(r.linked).toBe(0);
    expect(tasks[0].ownerContactId).toBeNull();
    expect(r.unmatched[0].reason).toBe('no contact with this name');
  });

  it('groups every task sharing an unmatched name into one entry', async () => {
    const { svc } = makeService(CONTACTS, [
      { id: 't1', party: 'Ramesh', ownerContactId: null },
      { id: 't2', party: 'ramesh', ownerContactId: null },
    ]);
    const r = await svc.linkExistingParties();
    expect(r.unmatched).toHaveLength(1);
    expect(r.unmatched[0].taskIds).toEqual(['t1', 't2']);
  });

  it('a dry run reports the same thing but changes nothing', async () => {
    const { svc, tasks } = makeService(CONTACTS, [{ id: 't1', party: 'Srikar', ownerContactId: null }]);
    const r = await svc.linkExistingParties(true);
    expect(r.linked).toBe(1);
    expect(tasks[0].ownerContactId).toBeNull(); // untouched
  });

  it('never touches a task that is already linked', async () => {
    const { svc, tasks } = makeService(CONTACTS, [{ id: 't1', party: 'Old Name', ownerContactId: 'c1' }]);
    const r = await svc.linkExistingParties();
    expect(r.linked).toBe(0);
    expect(r.unmatched).toEqual([]);
    expect(tasks[0].party).toBe('Old Name');
  });

  it('ignores tasks with no person at all', async () => {
    const { svc } = makeService(CONTACTS, [{ id: 't1', party: null, ownerContactId: null }, { id: 't2', party: '  ', ownerContactId: null }]);
    const r = await svc.linkExistingParties();
    expect(r.linked).toBe(0);
    expect(r.unmatched).toEqual([]);
  });
});

describe('syncPeople — @mention links (BEA-1019)', () => {
  it('adds the mentioned people and never links the owner to themselves', async () => {
    const { svc, links } = makeService(CONTACTS, []);
    await svc.syncPeople('t1', ['c1', 'c2'], 'c1');
    expect(links.map((l) => l.contactId)).toEqual(['c2']);
  });

  it('replaces the set on a later save — removing a mention unlinks it', async () => {
    const { svc, links } = makeService(CONTACTS, []);
    await svc.syncPeople('t1', ['c1', 'c2'], null);
    await svc.syncPeople('t1', ['c2'], null);
    expect(links.map((l) => l.contactId)).toEqual(['c2']);
  });

  it('is idempotent — saving the same set twice does not duplicate', async () => {
    const { svc, links } = makeService(CONTACTS, []);
    await svc.syncPeople('t1', ['c2'], null);
    await svc.syncPeople('t1', ['c2'], null);
    expect(links).toHaveLength(1);
  });
});
