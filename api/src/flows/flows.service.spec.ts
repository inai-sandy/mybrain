import { FlowsService } from './flows.service';

/**
 * describeFlow/buildPrompt fidelity (BEA-686): the process + copy-prompt must reflect the canvas —
 * including a skill's guidance ("Level 2") and any finishing step wired AFTER the Merge.
 */
function svcWithGraph(graph: any) {
  const prisma = { flow: { findUnique: async () => ({ id: 'f1', name: 'Test flow', question: 'Big task', graph: JSON.stringify(graph) }) } };
  return new FlowsService(prisma as any, {} as any, {} as any);
}

// question → b0_sq → deep-research(skill, guidance "Level 2") → ask_ai → merge ; merge → ui-ux(skill) → output
const GRAPH = {
  nodes: [
    { id: 'question', data: { kind: 'question', sub: 'Big task' } },
    { id: 'b0_sq', data: { kind: 'subquestion', label: 'Branch 1', sub: 'What is OKF?' } },
    { id: 'deep', data: { kind: 'skill', label: 'deep-research', guidance: 'Level 2' } },
    { id: 'b0_ai', data: { kind: 'ask_ai', label: 'Ask AI' } },
    { id: 'merge', data: { kind: 'merge', mode: 'ai' } },
    { id: 'uiux', data: { kind: 'skill', label: 'ui-ux-pro-max' } },
    { id: 'output', data: { kind: 'output', label: 'Output' } },
  ],
  edges: [
    { source: 'question', target: 'b0_sq' },
    { source: 'b0_sq', target: 'deep' },
    { source: 'deep', target: 'b0_ai' },
    { source: 'b0_ai', target: 'merge' },
    { source: 'merge', target: 'output' },
    { source: 'merge', target: 'uiux' },
    { source: 'uiux', target: 'output' },
  ],
};

describe('FlowsService.getPrompt — process/prompt fidelity (BEA-686)', () => {
  it('includes a skill\'s guidance ("Level 2") in its step text', async () => {
    const { process, prompt } = await svcWithGraph(GRAPH).getPrompt('f1');
    expect(process.branches[0].steps[0]).toBe('Use the "deep-research" skill — read its SKILL.md and follow it. (Level 2)');
    expect(prompt).toContain('(Level 2)');
  });

  it('surfaces a post-Merge node as a finishing step (in both process and prompt)', async () => {
    const { process, prompt } = await svcWithGraph(GRAPH).getPrompt('f1');
    expect(process.finishing).toEqual(['Use the "ui-ux-pro-max" skill — read its SKILL.md and follow it.']);
    expect(prompt).toContain('Then, as finishing steps applied to that combined answer:');
    expect(prompt).toContain('1. Use the "ui-ux-pro-max" skill');
  });

  it('has no finishing steps when the Merge goes straight to Output', async () => {
    const g = { nodes: GRAPH.nodes.filter((n) => n.id !== 'uiux'), edges: GRAPH.edges.filter((e) => e.source !== 'uiux' && e.target !== 'uiux') };
    const { process, prompt } = await svcWithGraph(g).getPrompt('f1');
    expect(process.finishing).toEqual([]);
    expect(prompt).not.toContain('finishing steps');
  });
});

/** Canvas → words sync (BEA-1065): drag-edit the flow → the agent's plain-words Task re-derives,
 *  shown as a diff and written ONLY on confirm (apply). */
describe('FlowsService canvas → words sync (BEA-1065)', () => {
  function syncSvc(llmOut: string | null, agentRow: any = { id: 'a1', prompt: 'old words' }) {
    const updates: any[] = [];
    const prisma = {
      flow: { findUnique: async () => ({ id: 'f1', name: 'Test flow', question: 'Big task', agentId: 'a1', graph: JSON.stringify(GRAPH) }) },
      agent: { findUnique: async () => agentRow, update: async (a: any) => { updates.push(a); return agentRow; } },
    };
    const llm = { complete: async () => { if (llmOut === null) throw new Error('rewriter down'); return llmOut; } };
    const prompts = { get: async () => 'TASK={{task}} FLOW={{flow}}' };
    return { svc: new FlowsService(prisma as any, {} as any, llm as any, prompts as any), updates };
  }

  it('preview returns old vs new + plain-English changes, and saves NOTHING', async () => {
    const { svc, updates } = syncSvc(JSON.stringify({ task: '1. New step plan', changes: ['Changed: step 1 now reads the notes first.'] }));
    const out = await svc.syncAgentPreview('f1');
    expect(out.oldTask).toBe('old words');
    expect(out.newTask).toBe('1. New step plan');
    expect(out.changes[0]).toMatch(/^Changed:/);
    expect(updates.length).toBe(0); // diff first — nothing written until apply
  });

  it('preview falls back to the word-for-word flow text when the rewriter is down', async () => {
    const { svc } = syncSvc(null);
    const out = await svc.syncAgentPreview('f1');
    expect(out.newTask).toContain('Task: Big task');
    expect(out.changes[0]).toContain('word-for-word');
  });

  it('apply writes the confirmed Task onto the linked agent', async () => {
    const { svc, updates } = syncSvc('');
    const r = await svc.syncAgentApply('f1', '  the new task  ');
    expect(r.ok).toBe(true);
    expect(updates[0].data.prompt).toBe('the new task');
  });

  it('refuses when the flow is not linked to an agent', async () => {
    const prisma = { flow: { findUnique: async () => ({ id: 'f1', agentId: null, graph: '{}' }) } };
    const svc = new FlowsService(prisma as any, {} as any, {} as any);
    await expect(svc.syncAgentPreview('f1')).rejects.toThrow('not linked');
    await expect(svc.syncAgentApply('f1', 'x')).rejects.toThrow('not linked');
  });
});

/** BEA-1096: the auto-planner must NOT add "search my brain" by default — and the planner prompt
 *  is now the editable registry entry `flow.plan`. */
describe('planFlow — no search_brain by default (BEA-1096)', () => {
  it('fills the registry template and builds the graph from the plan', async () => {
    const seen: string[] = [];
    const skills = { list: async () => [] };
    const llm = { complete: async (p: string) => { seen.push(p); return JSON.stringify({ branches: [{ subquestion: 'Tesla facts', steps: [{ kind: 'tool', id: 'web_search' }, { kind: 'ask_ai' }] }], merge: 'ai' }); } };
    const prompts = { get: async (k: string) => (k === 'flow.plan' ? 'Q={{question}} T={{tools}} S={{skills}}' : '') };
    const svc = new FlowsService({} as any, skills as any, llm as any, prompts as any);
    const g = await svc.planFlow('research Tesla');
    expect(seen[0]).toContain('Q=research Tesla');
    expect(g.nodes.some((n: any) => n.data.refId === 'web_search')).toBe(true);
    expect(g.nodes.some((n: any) => n.data.refId === 'search_brain')).toBe(false);
  });

  it('the default planner prompt forbids search_brain unless explicitly asked', async () => {
    const { PromptsService } = await import('../prompts/prompts.service');
    const real = new PromptsService({ setting: { findUnique: async () => null } } as any);
    const def = await real.get('flow.plan');
    expect(def).toContain('Do NOT use search_brain unless the request EXPLICITLY asks');
    expect(def).not.toContain("INCLUDE one branch that uses search_brain");
  });
});

/**
 * BEA-1174 — the flow drawn for a job may only use tools that job is allowed to run. A step it
 * would be refused at run time is a picture that lies.
 */
describe('planning inside the job toolbox (BEA-1174)', () => {
  const catalog = {
    catalog: async () => ({
      groups: [],
      tools: [
        { id: 'web_search', name: 'Web search', group: 'Web', description: 'web', connected: true, kind: 'tool' },
        { id: 'gmail', name: 'Gmail', group: 'Google', description: 'email', connected: true, kind: 'tool' },
        { id: 'search_brain', name: 'Search my brain', group: 'Brain', description: 'brain', connected: true, kind: 'tool' },
      ],
    }),
  } as any;

  function svc(seen: string[]) {
    const llm = { complete: async (p: string) => { seen.push(p); return JSON.stringify({ branches: [{ subquestion: 'q', steps: [{ kind: 'tool', id: 'web_search' }] }], merge: 'ai' }); } };
    const prompts = { get: async () => 'T={{tools}}' };
    return new FlowsService({} as any, { list: async () => [] } as any, llm as any, prompts as any, catalog);
  }

  it('offers every connected tool when the job has no toolbox of its own', async () => {
    const seen: string[] = [];
    await svc(seen).planFlow('anything', null);
    expect(seen[0]).toContain('web_search');
    expect(seen[0]).toContain('gmail');
  });

  it('offers ONLY the job\'s tools when it has them', async () => {
    const seen: string[] = [];
    await svc(seen).planFlow('anything', ['web_search']);
    expect(seen[0]).toContain('web_search');
    expect(seen[0]).not.toContain('gmail');
    expect(seen[0]).not.toContain('search_brain');
  });

  it('does not end up with nothing when the toolbox names something unknown', async () => {
    const seen: string[] = [];
    await svc(seen).planFlow('anything', ['not_a_real_tool']);
    expect(seen[0]).toContain('web_search'); // falls back rather than planning a toolless flow
  });
});

/**
 * BEA-1174 — a job's task is an instruction list ("1. Every Monday at 8am, search…"), not a
 * question. The planner returns nothing useful for that shape, which silently produced a flow that
 * was one "Ask AI" box. It must condense and try again rather than accept the empty result.
 */
describe('planning from a numbered job task (BEA-1174)', () => {
  const catalog = { catalog: async () => ({ groups: [], tools: [{ id: 'web_search', name: 'Web search', group: 'Web', description: 'web', connected: true, kind: 'tool' }] }) } as any;
  const TASK = '1. Every Monday at 8:00 AM, search for Indian government rule changes about EV batteries.\n2. Write a one-page brief with sources.';

  it('retries with a condensed goal and ends up with real steps', async () => {
    const asked: string[] = [];
    const llm = {
      complete: async (p: string) => {
        asked.push(p);
        // First attempt returns prose (what the real planner does with an instruction list).
        if (asked.length === 1) return 'Sorry, I need a clearer goal.';
        return JSON.stringify({ branches: [{ subquestion: 'rule changes', steps: [{ kind: 'tool', id: 'web_search' }] }], merge: 'ai' });
      },
    };
    const svc = new FlowsService({} as any, { list: async () => [] } as any, llm as any, { get: async () => 'T={{question}} {{tools}}' } as any, catalog);
    const g = await svc.planFlow(TASK);
    expect(asked.length).toBe(2); // it tried again
    expect(asked[1]).not.toContain('Every Monday'); // the schedule preamble is gone
    expect(g.nodes.some((n: any) => n.data.refId === 'web_search')).toBe(true);
  });

  it('does not retry when the first attempt already worked', async () => {
    const asked: string[] = [];
    const llm = { complete: async (p: string) => { asked.push(p); return JSON.stringify({ branches: [{ subquestion: 'x', steps: [{ kind: 'tool', id: 'web_search' }] }], merge: 'ai' }); } };
    const svc = new FlowsService({} as any, { list: async () => [] } as any, llm as any, { get: async () => 'T={{question}} {{tools}}' } as any, catalog);
    await svc.planFlow(TASK);
    expect(asked.length).toBe(1);
  });
});

/**
 * BEA-1241 — the owner's 1,254-character, ten-point question was clipped in five separate places.
 * The canvas node kept 300, the planner saw 600, the merge goal 500. Points 4 to 10 never reached a
 * single search, and the run was then graded down for not answering them. Nothing said a word.
 */
describe('the WHOLE question reaches the flow (BEA-1241)', () => {
  const longQuestion = [
    '1. Study Engineering Degree and MBA students for 2025 and 2026 in Pune, Mumbai, Hyderabad, Bangalore, Chennai, and Ahmedabad.',
    '2. Find reliable data on how many students passed out or are expected to pass out in each city.',
    '3. Find placement data from colleges, placement reports, government data, industry reports.',
    '4. Break placements into campus interviews, off-campus placements and fresher jobs.',
    '5. Show placement percentages, not just counts.',
    '6. Break placements by job category — IT, AI, core engineering, sales, finance, consulting.',
    '7. Explain whether AI is reducing fresher jobs in India.',
    '8. Include student interest in business or startup plans.',
    '9. Compare the cities against each other on outcomes.',
    '10. Save a detailed sourced report in Documents with tables, links, assumptions, gaps and clear conclusions.',
  ].join('\n');

  const build = (plan: any) => {
    const svc = new FlowsService({} as any, {} as any, {} as any);
    return (svc as any).buildGraph(longQuestion, plan, new Map(), new Map());
  };

  it('keeps every point in the question node — not the first 300 characters', () => {
    const g = build({ branches: [{ subquestion: 'a', steps: [{ kind: 'ask_ai' }] }] });
    const q = g.nodes.find((n: any) => n.data?.kind === 'question');
    expect(q.data.sub).toBe(longQuestion);
    expect(q.data.sub).toContain('AI is reducing fresher jobs');       // point 7 — used to be cut
    expect(q.data.sub).toContain('Save a detailed sourced report');    // point 10 — used to be cut
    expect(longQuestion.length).toBeGreaterThan(300);                  // the test is meaningful
  });

  it('gives the MERGE the whole goal, so the final answer knows what was asked', () => {
    const g = build({ branches: [{ subquestion: 'a', steps: [{ kind: 'ask_ai' }] }] });
    const merge = g.nodes.find((n: any) => n.data?.kind === 'merge');
    expect(merge.data.goal).toBe(longQuestion);
    expect(merge.data.goal).toContain('startup plans'); // point 8 — the merge used to stop at 500
  });

  it('does not cut a branch sub-question mid-word', () => {
    // Real run, branch 3: "…Pune, Mumbai, Hyderabad, Bangalore, Chennai, and Ahmed" — exactly 200
    // characters, cut inside "Ahmedabad", so one of the six cities was silently dropped.
    const long = 'Find the distribution of job categories such as IT, AI, core engineering, sales, finance, and consulting for fresher Engineering and MBA roles in Pune, Mumbai, Hyderabad, Bangalore, Chennai, and Ahmedabad.';
    const g = build({ branches: [{ subquestion: long, steps: [{ kind: 'ask_ai' }] }] });
    const sq = g.nodes.find((n: any) => n.data?.kind === 'subquestion');
    expect(sq.data.sub).toBe(long);
    expect(sq.data.sub).toContain('Ahmedabad');
    expect(long.length).toBeGreaterThan(200);
  });

  it('does not lose the question when the planner returns nothing', () => {
    const g = build(null);
    const sq = g.nodes.find((n: any) => n.data?.kind === 'subquestion');
    expect(sq.data.sub).toBe(longQuestion); // the fallback branch used to keep only 200 characters
  });
});
