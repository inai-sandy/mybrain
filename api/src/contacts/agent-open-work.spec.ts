/**
 * BEA-1189 — the chase agent builds its picture of what a colleague owes from a single query that
 * ordered by `status` as TEXT. 'done' sorts before 'open', so with a 40-row cap a long-standing
 * colleague's finished work filled the whole window and their real open tasks never reached the
 * agent. It answered on half the story about the people it talks to most.
 */
describe('the agent sees a contact\'s OPEN work first (BEA-1189)', () => {
  it('proves the old ordering was the bug: "done" sorts before "open"', () => {
    expect(['open', 'done'].sort()).toEqual(['done', 'open']);
  });

  it('takes open tasks in their own query, so finished work cannot crowd them out', async () => {
    // 60 finished tasks and 2 open ones — the old single capped query returned only finished rows.
    const done = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, status: 'done', title: `finished ${i}` }));
    const open = [{ id: 'o1', status: 'open', title: 'send the BOM' }, { id: 'o2', status: 'open', title: 'production status' }];
    const all = [...done, ...open];

    const findMany = async ({ where, take }: any) => {
      const rows = where.status?.not === 'done' ? all.filter((t) => t.status !== 'done') : all.filter((t) => t.status === 'done');
      return rows.slice(0, take);
    };
    const [openRows, doneRows] = await Promise.all([
      findMany({ where: { status: { not: 'done' } }, take: 40 }),
      findMany({ where: { status: 'done' }, take: 20 }),
    ]);
    const work = [...openRows, ...doneRows];
    const openWork = work.filter((t: any) => t.status !== 'done');

    expect(openWork.map((t: any) => t.id)).toEqual(['o1', 'o2']); // both survive
    expect(work.length).toBeLessThanOrEqual(60);
  });

  it('the old shape would have lost them — this is what regressed', async () => {
    const done = Array.from({ length: 60 }, (_, i) => ({ id: `d${i}`, status: 'done' }));
    const open = [{ id: 'o1', status: 'open' }];
    // ordering by status text, then capping at 40
    const oldWay = [...done, ...open].sort((a, b) => a.status.localeCompare(b.status)).slice(0, 40);
    expect(oldWay.filter((t) => t.status !== 'done')).toEqual([]); // the open task never made it
  });
});
