import { ContactsService } from './contacts.service';

/**
 * The link has to be BOTH readable and unguessable — readable alone means typing someone else's
 * name shows you their work. And the public board must never leak anything but their own list.
 * (BEA-1027)
 */
function make(contacts: any[], tasks: any[] = []) {
  const prisma: any = {
    contact: {
      findUnique: async ({ where }: any) =>
        contacts.find((c) => (where.id && c.id === where.id) || (where.shareSlug && c.shareSlug === where.shareSlug)) || null,
      update: async ({ where, data }: any) => { const c = contacts.find((x) => x.id === where.id); Object.assign(c, data); return c; },
    },
    task: { findMany: async ({ where }: any) => tasks.filter((t) => t.ownerContactId === where.ownerContactId) },
  };
  return { svc: new ContactsService(prisma) as any, contacts };
}

describe('the contact share link (BEA-1027)', () => {
  it('is their name plus a random tail', async () => {
    const { svc } = make([{ id: 'c1', name: 'Vijaya Durga', shareEnabled: true, shareSlug: null }]);
    const s = await svc.share('c1');
    expect(s.slug).toMatch(/^vijaya-durga-[a-z2-9]{4}$/);
    expect(s.path).toBe(`/t/${s.slug}`);
  });

  it('is stable — asking twice gives the same link', async () => {
    const { svc } = make([{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: null }]);
    const a = await svc.share('c1');
    const b = await svc.share('c1');
    expect(b.slug).toBe(a.slug);
  });

  it('never uses characters that are ambiguous when read aloud', async () => {
    const { svc } = make([{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: null }]);
    for (let i = 0; i < 30; i++) {
      const { svc: s2 } = make([{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: null }]);
      const tail = (await s2.share('c1')).slug.split('-').pop();
      expect(tail).not.toMatch(/[01ilo]/);
    }
    expect((await svc.share('c1')).slug).toBeTruthy();
  });

  it('copes with a name that has no usable letters', async () => {
    const { svc } = make([{ id: 'c1', name: '???', shareEnabled: true, shareSlug: null }]);
    expect((await svc.share('c1')).slug).toMatch(/^person-/);
  });

  it('rotating issues a different link', async () => {
    const { svc } = make([{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: null }]);
    const a = await svc.share('c1');
    const b = await svc.rotateShare('c1');
    expect(b.slug).not.toBe(a.slug);
  });

  it('turning it off makes the page say so instead of showing the list', async () => {
    const { svc } = make([{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: 'ramesh-abcd' }], [{ id: 't1', ownerContactId: 'c1', status: 'open', title: 'secret', createdAt: new Date(), claims: [] }]);
    await svc.setShareEnabled('c1', false);
    const board = await svc.publicBoard('ramesh-abcd');
    expect(board.off).toBe(true);
    expect(board.open).toBeUndefined(); // nothing leaks
  });

  it('an unknown link is rejected, not answered with an empty list', async () => {
    const { svc } = make([{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: 'ramesh-abcd' }]);
    await expect(svc.publicBoard('ramesh-wxyz')).rejects.toThrow();
  });

  it('shows their open work and their finished work, and nobody else’s', async () => {
    const now = new Date();
    const { svc } = make(
      [{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: 'ramesh-abcd' }],
      [
        { id: 't1', ownerContactId: 'c1', status: 'open', title: 'Send the vendor list', createdAt: now, claims: [] },
        { id: 't2', ownerContactId: 'c1', status: 'done', title: 'GST filing', createdAt: now, completedAt: now, claims: [] },
        { id: 't3', ownerContactId: 'other', status: 'open', title: 'SOMEONE ELSE', createdAt: now, claims: [] },
      ],
    );
    const board = await svc.publicBoard('ramesh-abcd');
    expect(board.open.map((t: any) => t.title)).toEqual(['Send the vendor list']);
    expect(board.done.map((t: any) => t.title)).toEqual(['GST filing']);
    expect(JSON.stringify(board)).not.toContain('SOMEONE ELSE');
  });

  it('tells them when something is already with Sandeep for checking', async () => {
    const now = new Date();
    const { svc } = make(
      [{ id: 'c1', name: 'Ramesh', shareEnabled: true, shareSlug: 'ramesh-abcd' }],
      [{ id: 't1', ownerContactId: 'c1', status: 'open', title: 'x', createdAt: now, claims: [{ id: 'k1', quote: 'sent it', createdAt: now }] }],
    );
    const board = await svc.publicBoard('ramesh-abcd');
    expect(board.open[0].claimed).toMatchObject({ note: 'sent it' });
  });
});
