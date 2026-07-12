import { IdeasService } from './ideas.service';

describe('IdeasService.remove — full delete (BEA-963)', () => {
  it('deletes the idea, its linked docs, RAG + SuperMemory, workflow, and file', async () => {
    const calls: any = { itemsRemoved: [], deletedDoc: null, wfDeleted: false, ideaDeleted: false };
    const idea = { id: 'i1', title: 'My Idea', supermemoryId: 'sm1', ragId: 'rag1' };
    const prisma: any = {
      idea: { findUnique: async () => idea, delete: async () => { calls.ideaDeleted = true; return idea; } },
      item: { findMany: async () => [{ id: 'd1' }, { id: 'd2' }] },
      ideaWorkflow: { deleteMany: async () => { calls.wfDeleted = true; return { count: 1 }; } },
    };
    const memory: any = { deleteDoc: async (sm: string, rag: string) => { calls.deletedDoc = { sm, rag }; } };
    const items: any = { remove: async (id: string) => { calls.itemsRemoved.push(id); } };
    const svc = new IdeasService(prisma, memory, {} as any, items, {} as any);
    const r = await svc.remove('i1');
    expect(r).toEqual({ ok: true, deletedDocs: 2 });
    expect(calls.itemsRemoved).toEqual(['d1', 'd2']); // each linked doc fully wiped
    expect(calls.deletedDoc).toEqual({ sm: 'sm1', rag: 'rag1' }); // idea's own RAG + SuperMemory removed
    expect(calls.wfDeleted).toBe(true); // workflow deleted
    expect(calls.ideaDeleted).toBe(true); // idea record deleted
  });

  it('returns ok:false for a missing idea', async () => {
    const prisma: any = { idea: { findUnique: async () => null } };
    const svc = new IdeasService(prisma, {} as any, {} as any, {} as any, {} as any);
    expect(await svc.remove('nope')).toEqual({ ok: false, deletedDocs: 0 });
  });
});
