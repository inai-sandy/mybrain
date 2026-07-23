import { TasksService } from './tasks.service';

/**
 * Remove-duplicates must MERGE, never plain-delete: the copies' notes, progress, owner, chases and
 * people-links move onto the keeper before the copies go. And the finder's wording pre-pass must
 * catch heavy-overlap titles without any AI. (BEA-1057)
 */
function make(tasks: any[]) {
  const updates: any[] = [];
  const deleted: string[] = [];
  const reminderMoves: any[] = [];
  const claimMoves: any[] = [];
  const upserts: any[] = [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const prisma: any = {
    task: {
      findUnique: async ({ where }: any) => byId.get(where.id) || null,
      findMany: async ({ where }: any) => {
        if (where?.id?.in) return tasks.filter((t) => where.id.in.includes(t.id) && !where.id.notIn?.includes(t.id) && t.status === 'open');
        return tasks;
      },
      update: async ({ where, data }: any) => { updates.push({ id: where.id, ...data }); Object.assign(byId.get(where.id) || {}, data); return byId.get(where.id); },
      delete: async ({ where }: any) => { deleted.push(where.id); return byId.get(where.id); },
    },
    reminder: {
      count: async () => tasks.find((t) => t.id === 'keep')?.hasChase ? 1 : 0,
      updateMany: async ({ where, data }: any) => { reminderMoves.push({ from: where.taskId, to: data.taskId }); return { count: 1 }; },
    },
    taskClaim: { updateMany: async ({ where, data }: any) => { claimMoves.push({ from: where.taskId, to: data.taskId }); return { count: 1 }; } },
    taskPerson: {
      findMany: async ({ where }: any) => (byId.get(where.taskId)?.people || []).map((contactId: string) => ({ taskId: where.taskId, contactId })),
      upsert: async ({ where }: any) => { upserts.push(where.taskId_contactId); return {}; },
    },
  };
  const svc = new TasksService(prisma, {} as any, {} as any, { enqueue: async () => undefined, deleteDoc: async () => undefined, indexEntity: async () => undefined } as any);
  return { svc, updates, deleted, reminderMoves, claimMoves, upserts };
}

const base = { status: 'open', priority: 'medium', progress: 0, note: null, ownerContactId: null, party: null, pinned: false, estimateMin: null, promisedFor: null, briefingId: null, people: [] };

describe('mergeDuplicates — nothing of value is lost (BEA-1057)', () => {
  it('moves note, progress, owner, priority and people onto the keeper, then removes the copy', async () => {
    const keep = { ...base, id: 'keep', title: 'Send report to Madhuri' };
    const dup = { ...base, id: 'dup', title: 'Get the report sent', note: 'she promised Friday', progress: 30, ownerContactId: 'c1', party: 'Madhuri', priority: 'high', people: ['c9'] };
    const { svc, updates, deleted, reminderMoves, claimMoves, upserts } = make([keep, dup]);
    const r = await svc.mergeDuplicates([{ keepId: 'keep', removeIds: ['dup'] }]);
    expect(r).toEqual({ merged: 1, removed: 1 });
    expect(updates[0]).toMatchObject({ id: 'keep', note: 'she promised Friday', progress: 30, ownerContactId: 'c1', party: 'Madhuri', priority: 'high' });
    expect(reminderMoves).toEqual([{ from: 'dup', to: 'keep' }]); // the chase follows the work
    expect(claimMoves).toEqual([{ from: 'dup', to: 'keep' }]);
    expect(upserts).toEqual([{ taskId: 'keep', contactId: 'c9' }]);
    expect(deleted).toEqual(['dup']);
  });

  it('does NOT move a chase onto a keeper that already has one — no double chasing', async () => {
    const keep = { ...base, id: 'keep', title: 'A', hasChase: true };
    const dup = { ...base, id: 'dup', title: 'A again' };
    const { svc, reminderMoves } = make([keep, dup]);
    await svc.mergeDuplicates([{ keepId: 'keep', removeIds: ['dup'] }]);
    expect(reminderMoves).toEqual([]); // the copy's chase dies with it instead
  });

  it('refuses to touch completed history', async () => {
    const keep = { ...base, id: 'keep', title: 'A', status: 'done' };
    const dup = { ...base, id: 'dup', title: 'A again' };
    const { svc, deleted } = make([keep, dup]);
    expect(await svc.mergeDuplicates([{ keepId: 'keep', removeIds: ['dup'] }])).toEqual({ merged: 0, removed: 0 });
    expect(deleted).toEqual([]);
  });

  it('ignores a group whose keeper is listed in its own removeIds', async () => {
    const keep = { ...base, id: 'keep', title: 'A' };
    const { svc, deleted } = make([keep]);
    await svc.mergeDuplicates([{ keepId: 'keep', removeIds: ['keep'] }]);
    expect(deleted).toEqual([]);
  });
});

describe('the wording pre-pass groups heavy-overlap titles without AI (BEA-1057)', () => {
  const lex = (rows: { id: string; title: string }[]) => (new TasksService({} as any, {} as any, {} as any, {} as any) as any).lexicalGroups(rows);

  it('groups reworded copies of the same task', () => {
    const groups = lex([
      { id: '1', title: 'Get the Haasya components report from Madhuri' },
      { id: '2', title: 'Haasya components report — Madhuri' },
      { id: '3', title: 'Order new solder paste' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['1', '2']);
  });

  it('does not group tasks that merely share one common word', () => {
    const groups = lex([
      { id: '1', title: 'Send the invoice to Srikar' },
      { id: '2', title: 'Send the firmware build to testers' },
    ]);
    expect(groups).toHaveLength(0);
  });
});
