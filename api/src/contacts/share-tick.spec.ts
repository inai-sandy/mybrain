import { ContactsService } from './contacts.service';

/**
 * The tick endpoint needs NO login, so its guards are the security boundary: you may only tick
 * work that is actually yours, on a link that is actually live. (BEA-1028)
 */
function make(contacts: any[], tasks: any[]) {
  const prisma: any = {
    contact: {
      findUnique: async ({ where }: any) =>
        contacts.find((c) => (where.id && c.id === where.id) || (where.shareSlug && c.shareSlug === where.shareSlug)) || null,
      update: async () => ({}),
    },
    task: { findUnique: async ({ where }: any) => tasks.find((t) => t.id === where.id) || null, findMany: async () => tasks },
  };
  return new ContactsService(prisma) as any;
}

const C = [
  { id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: 'ramesh-abcd' },
  { id: 'c2', name: 'Suresh', shareEnabled: true, shareSlug: 'suresh-wxyz' },
  { id: 'c3', name: 'Off', shareEnabled: false, shareSlug: 'off-1234' },
];
const T = [
  { id: 't1', ownerContactId: 'c1', status: 'open' },
  { id: 't2', ownerContactId: 'c2', status: 'open' },
  { id: 't3', ownerContactId: 'c1', status: 'done' },
];

describe('contactForShare — the link is the key (BEA-1028)', () => {
  it('resolves a live link', async () => {
    expect((await make(C, T).contactForShare('ramesh-abcd')).id).toBe('c1');
  });
  it('refuses an unknown link', async () => {
    await expect(make(C, T).contactForShare('nope-0000')).rejects.toThrow();
  });
  it('refuses a link whose page has been turned off', async () => {
    await expect(make(C, T).contactForShare('off-1234')).rejects.toThrow();
  });
});

describe('ownsTask — you may only tick your own work (BEA-1028)', () => {
  it('allows their own open task', async () => {
    expect(await make(C, T).ownsTask('c1', 't1')).toBe(true);
  });
  it('REFUSES someone else’s task', async () => {
    expect(await make(C, T).ownsTask('c1', 't2')).toBe(false);
  });
  it('refuses a task that is already finished', async () => {
    expect(await make(C, T).ownsTask('c1', 't3')).toBe(false);
  });
  it('refuses a task that does not exist', async () => {
    expect(await make(C, T).ownsTask('c1', 'nope')).toBe(false);
  });
  it('refuses empty input rather than throwing', async () => {
    expect(await make(C, T).ownsTask('c1', '')).toBe(false);
  });
});
