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
