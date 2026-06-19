import { AccountabilityService } from './accountability.service';

function makePrisma() {
  const commitments: any[] = [];
  const decisions: any[] = [];
  const prisma: any = {
    setting: { findUnique: async () => null, upsert: async () => ({}) },
    story: { findFirst: async () => ({ rawText: "I'll send Diksha the quote by Friday. We decided to go with the rust design." }) },
    daySummary: { findUnique: async () => null },
    dayStory: { findUnique: async () => null },
    task: { findMany: async () => [] },
    commitment: {
      findMany: async () => commitments.map((c) => ({ text: c.text })),
      create: async ({ data }: any) => {
        commitments.push({ id: String(commitments.length + 1), status: 'open', ...data });
        return commitments[commitments.length - 1];
      },
      update: async ({ where, data }: any) => {
        const c = commitments.find((x) => x.id === where.id);
        Object.assign(c, data);
        return c;
      },
    },
    decision: {
      findMany: async () => decisions.map((d) => ({ text: d.text })),
      create: async ({ data }: any) => {
        decisions.push({ id: String(decisions.length + 1), ...data });
        return decisions[decisions.length - 1];
      },
    },
    _commitments: commitments,
    _decisions: decisions,
  };
  return prisma;
}

describe('AccountabilityService.extractForDay', () => {
  const answer = '{"commitments":[{"text":"Send Diksha the quote","party":"Diksha","due":"2026-06-20"}],"decisions":[{"text":"Go with the rust design","context":"design"}]}';

  it('extracts a commitment + decision and de-dups on re-run', async () => {
    const prisma = makePrisma();
    const llm: any = { completeWith: jest.fn(async () => answer) };
    const svc = new AccountabilityService(prisma, llm);

    const r1 = await svc.extractForDay('2026-06-19');
    expect(r1.commitments).toBe(1);
    expect(r1.decisions).toBe(1);
    expect(prisma._commitments[0]).toMatchObject({ party: 'Diksha', dueDate: '2026-06-20', status: 'open' });

    const r2 = await svc.extractForDay('2026-06-19');
    expect(r2.commitments).toBe(0); // de-duped
    expect(r2.decisions).toBe(0);
    expect(prisma._commitments).toHaveLength(1);
  });

  it('mark-done sets completedAt', async () => {
    const prisma = makePrisma();
    const svc = new AccountabilityService(prisma, { completeWith: jest.fn(async () => answer) } as any);
    await svc.extractForDay('2026-06-19');
    await svc.setStatus('1', 'done');
    expect(prisma._commitments[0].status).toBe('done');
    expect(prisma._commitments[0].completedAt).toBeTruthy();
  });
});
