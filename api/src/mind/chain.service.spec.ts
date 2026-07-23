import { whereForDayRule } from '../tasks/day-rule';
import { MindChainService } from './chain.service';

// Stands in for TasksService using the REAL day rule, so this double can't drift from it. (BEA-1018)
const IST_MIN = 330;
const dayWin = (d: string) => { const start = new Date(Date.parse(`${d}T00:00:00Z`) - IST_MIN * 60000); return { start, end: new Date(start.getTime() + 86400000) }; };
const tasksSvc: any = {
  timezone: async () => 'Asia/Kolkata',
  dayWindow: async (d: string) => dayWin(d),
  dayKeyOf: (x: any) => new Date(new Date(x).getTime() + IST_MIN * 60000).toISOString().slice(0, 10),
  whereForDay: async (d: string) => { const { start, end } = dayWin(d); return whereForDayRule(d, start, end); },
};

// Minimal fakes: a story + tasks in, captured mindChain.create calls out.
function fakePrisma(storyText: string | null, tasks: any[] = []) {
  const created: any[] = [];
  return {
    _created: created,
    task: { findMany: async () => tasks },
    story: { findFirst: async () => (storyText ? { rawText: storyText } : null) },
    mindChain: {
      findMany: async () => [],
      create: async ({ data }: any) => {
        const row = { id: 'c' + (created.length + 1), ...data };
        created.push(row);
        return row;
      },
    },
  };
}
const fakeLlm = (json: string) => ({ completeWith: async () => json });

const STORY =
  'Today I worked on Beakn application flows. The dependencies are blocking me from finishing the application form. ' +
  'In the evening I took Preeti to dinner.';

describe('MindChainService.inferFromDay grounding (BEA-602)', () => {
  it('keeps a chain grounded in a real quote and drops one whose evidence is not in the story', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        chains: [
          {
            goal: 'Finish the application form',
            blocker: 'dependencies are blocking me',
            lever: "When after lunch, I'll clear one dependency",
            evidence: 'dependencies are blocking me from finishing the application form',
          },
          {
            goal: 'Reduce interruptions',
            blocker: 'Rakesh breaking discipline keeps pulling focus',
            lever: "When I get to work, I'll set boundaries",
            evidence: 'Rakesh broke discipline today and crashed my mood', // NOT in the story
          },
        ],
      }),
    );
    const prisma = fakePrisma(STORY);
    const svc = new MindChainService(prisma as any, llm as any, tasksSvc, { get: async () => '' } as any);
    const n = await svc.inferFromDay('2026-06-26');
    expect(n).toBe(1);
    expect(prisma._created).toHaveLength(1);
    expect(prisma._created[0].blocker).toContain('dependencies');
    expect(prisma._created[0].provenance).toContain('from your words:');
  });

  it('drops a chain that names a person absent from the day, even with a real quote', async () => {
    const llm = fakeLlm(
      JSON.stringify({
        chains: [
          {
            goal: 'Protect focus',
            blocker: 'Rakesh keeps interrupting the production line', // Rakesh is not in the story
            lever: "When after my coffee, I'll batch interruptions",
            evidence: 'the dependencies are blocking me from finishing the application form', // real quote
          },
        ],
      }),
    );
    const prisma = fakePrisma(STORY);
    const svc = new MindChainService(prisma as any, llm as any, tasksSvc, { get: async () => '' } as any);
    const n = await svc.inferFromDay('2026-06-26');
    expect(n).toBe(0);
    expect(prisma._created).toHaveLength(0);
  });

  it('infers nothing when there is no story for the day', async () => {
    const llm = fakeLlm('{"chains":[]}');
    const prisma = fakePrisma(null, [{ title: 'x', status: 'todo', rolloverCount: 3 }]);
    const svc = new MindChainService(prisma as any, llm as any, tasksSvc, { get: async () => '' } as any);
    expect(await svc.inferFromDay('2026-06-26')).toBe(0);
  });
});
