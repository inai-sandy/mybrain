import { PromptsService } from '../prompts/prompts.service';
import { FlowsService } from './flows.service';

/**
 * BEA-1246 — the planner has to choose how DEEP each branch goes.
 *
 * The old rule was one line: "For facts about the world, use web_search then ask_ai." It never
 * mentioned deep_research, so the planner never picked it. Measured on three freshly planned flows
 * (news, bookmarking, research): 0 of 11 web branches used deep_research — every one used plain
 * web_search, which is Tavily alone.
 *
 * That made "Auto-plan" a trap. The owner's live research flow carried deep_research on 3 of its 4
 * branches; re-planning would have replaced them with a single-index lookup and silently thrown away
 * the three-index sweep, the page reading and the budget caps from BEA-1239. Nothing on screen would
 * have said so.
 *
 * These tests lock the rule in place. They deliberately assert on the DEFAULT prompt text, because
 * the bug was in the words, not the wiring.
 */

function promptsSvc() {
  const store: Record<string, string> = {};
  const prisma: any = {
    setting: {
      findUnique: async ({ where }: any) => (store[where.key] !== undefined ? { key: where.key, value: store[where.key] } : null),
      upsert: async ({ where, create, update }: any) => { store[where.key] = update?.value ?? create.value; return { key: where.key, value: store[where.key] }; },
      deleteMany: async ({ where }: any) => { delete store[where.key]; return { count: 1 }; },
    },
  };
  return new PromptsService(prisma);
}

describe('the planner chooses depth per branch (BEA-1246)', () => {
  it('the default prompt offers deep_research as a real choice', async () => {
    const tpl = await promptsSvc().get('flow.plan');
    expect(tpl).toContain('deep_research');
  });

  it('it no longer hard-codes web_search for every world fact', async () => {
    const tpl = await promptsSvc().get('flow.plan');
    // The exact line that caused the bug. If it comes back, so does the bug.
    expect(tpl).not.toContain('For facts about the world, use web_search then ask_ai.');
  });

  it('it states the trade-off, so the choice is informed rather than a coin toss', async () => {
    const tpl = await promptsSvc().get('flow.plan').then((t) => t.toLowerCase());
    // Why you would pay for depth...
    expect(tpl).toMatch(/credits|takes minutes/);
    // ...and why you would not.
    expect(tpl).toMatch(/fast and cheap|one keyword lookup|single fact/);
  });

  it('it warns against putting deep research on every branch of a daily job', async () => {
    const tpl = await promptsSvc().get('flow.plan').then((t) => t.toLowerCase());
    expect(tpl).toMatch(/daily|round-up|digest|repeating/);
    expect(tpl).toMatch(/not put deep_research on every branch|often none/);
  });
});

describe('a deep_research step survives planning (BEA-1246)', () => {
  const catalog = {
    catalog: async () => ({
      groups: [],
      tools: [
        { id: 'web_search', name: 'Web search', group: 'Web', description: 'keyword search', connected: true, kind: 'tool' },
        { id: 'deep_research', name: 'Deep research', group: 'Web', description: 'digs properly', connected: true, kind: 'tool' },
      ],
    }),
  } as any;

  function svc(seen: string[], plan: any) {
    const llm = { complete: async (p: string) => { seen.push(p); return JSON.stringify(plan); } };
    // The real prompt, not a stub — this is what proves the guidance actually reaches the model.
    const prompts = promptsSvc();
    return new FlowsService({} as any, { list: async () => [] } as any, llm as any, prompts as any, catalog);
  }

  it('sends the depth guidance to the model', async () => {
    const seen: string[] = [];
    await svc(seen, { branches: [{ subquestion: 'q', steps: [{ kind: 'ask_ai' }] }], merge: 'ai' }).planFlow('anything');
    expect(seen[0]).toContain('deep_research');
    expect(seen[0]).not.toContain('For facts about the world, use web_search then ask_ai.');
  });

  it('turns a planned deep_research step into a real Deep research node', async () => {
    const seen: string[] = [];
    const g = await svc(seen, {
      branches: [{ subquestion: 'rooftop solar costs', steps: [{ kind: 'tool', id: 'deep_research' }, { kind: 'ask_ai' }] }],
      merge: 'ai',
    }).planFlow('what does rooftop solar cost');
    const deep = g.nodes.filter((n: any) => n.data?.refId === 'deep_research');
    expect(deep).toHaveLength(1);
    expect(deep[0].data.label).toBe('Deep research');
    expect(deep[0].data.kind).toBe('tool');
  });

  it('still allows a plain web_search branch — depth is a choice, not a default', async () => {
    const seen: string[] = [];
    const g = await svc(seen, {
      branches: [{ subquestion: "today's headlines", steps: [{ kind: 'tool', id: 'web_search' }, { kind: 'ask_ai' }] }],
      merge: 'ai',
    }).planFlow('what happened today');
    expect(g.nodes.some((n: any) => n.data?.refId === 'web_search')).toBe(true);
    expect(g.nodes.some((n: any) => n.data?.refId === 'deep_research')).toBe(false);
  });
});
