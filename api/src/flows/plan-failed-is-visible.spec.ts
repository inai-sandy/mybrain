import { readFileSync } from 'fs';
import { join } from 'path';
import { FlowsService } from './flows.service';

/**
 * BEA-1253 — a failed auto-plan must not pass for a plan.
 *
 * When the splitter cannot answer at all — the first prompt AND the condensed retry — `planFlow`
 * falls back to one generic Ask-AI branch. That is a reasonable fallback and a terrible lie: the
 * endpoint returns 200, the editor's "could not plan" toast never fires, and the result is
 * indistinguishable from a genuine one-branch plan. The owner runs it, gets a thin answer, and has
 * no way to tell whether the flow or his question was at fault.
 */

function svc(planReply: string | null, opts: { prompt?: string } = {}) {
  const prisma: any = { flow: { findUnique: async () => null } };
  const llm: any = { completeHelper: async () => planReply };
  const skills: any = { list: async () => [] };
  const prompts: any = { get: async () => ('prompt' in opts ? opts.prompt : 'PLAN THIS {{question}} {{tools}} {{skills}}') };
  const catalog: any = {
    catalog: async () => ({
      groups: [],
      tools: [
        { id: 'web_search', name: 'Web search', group: 'Web', description: 'search', connected: true, kind: 'tool' },
        { id: 'ask_ai', name: 'Ask AI', group: 'AI', description: 'think', connected: true, kind: 'tool' },
      ],
    }),
  };
  return new FlowsService(prisma, skills, llm, prompts, catalog);
}

const GOOD_PLAN = JSON.stringify({
  branches: [
    { subquestion: 'What shipped?', steps: [{ kind: 'tool', id: 'web_search' }] },
    { subquestion: 'What did people say?', steps: [{ kind: 'ask_ai' }] },
  ],
});

const questionNode = (g: any) => g.nodes.find((n: any) => n.id === 'question');

describe('a failed plan says so on the graph (BEA-1253)', () => {
  it('marks the graph when the planner returns nothing at all', async () => {
    const g: any = await svc(null).planFlow('do the thing');
    expect(questionNode(g).data.planFailed).toBe(true);
    expect(questionNode(g).data.warn).toContain('bare fallback');
    expect(questionNode(g).data.warn).toContain('Auto-plan');
  });

  it('marks it when the reply is unparseable rubbish', async () => {
    const g: any = await svc('I am terribly sorry, I cannot help with that.').planFlow('do the thing');
    expect(questionNode(g).data.planFailed).toBe(true);
  });

  it('marks it when the reply parses but carries no branches', async () => {
    const g: any = await svc(JSON.stringify({ branches: [] })).planFlow('do the thing');
    expect(questionNode(g).data.planFailed).toBe(true);
  });

  it('marks it when the planner prompt itself is missing', async () => {
    const g: any = await svc(GOOD_PLAN, { prompt: '' }).planFlow('do the thing');
    expect(questionNode(g).data.planFailed).toBe(true);
  });

  it('marks it when the branches parse but are EMPTY SHELLS', async () => {
    // The narrower version of the same lie: valid JSON, a non-empty array, and every branch blank.
    // buildGraph falls through to the identical blank Ask-AI box, so it has to be flagged too.
    for (const reply of [
      JSON.stringify({ branches: [null] }),
      JSON.stringify({ branches: [{}] }),
      JSON.stringify({ branches: [{ subquestion: '   ' }] }),
      JSON.stringify({ branches: [{ subquestion: '', steps: [] }] }),
    ]) {
      const g: any = await svc(reply).planFlow('do the thing');
      expect({ reply, planFailed: questionNode(g).data.planFailed }).toEqual({ reply, planFailed: true });
    }
  });

  it('a branch with steps but no sub-question is still a REAL plan', async () => {
    // Only blank-on-every-count counts as failure — over-flagging would cry wolf on working flows.
    const g: any = await svc(JSON.stringify({ branches: [{ steps: [{ kind: 'tool', id: 'web_search' }] }] })).planFlow('x');
    expect(questionNode(g).data.planFailed).toBeUndefined();
  });

  it('still produces a usable graph — the fallback keeps working, it just stops pretending', async () => {
    const g: any = await svc(null).planFlow('do the thing');
    expect(g.nodes.some((n: any) => n.data.kind === 'merge')).toBe(true);
    expect(g.nodes.some((n: any) => n.data.kind === 'output')).toBe(true);
    expect(g.edges.length).toBeGreaterThan(0);
  });

  it('does NOT mark a real plan — including a genuine single-branch one', async () => {
    // The whole point is telling these two apart, so a false positive is as bad as a false negative.
    const good: any = await svc(GOOD_PLAN).planFlow('what happened');
    expect(questionNode(good).data.planFailed).toBeUndefined();
    expect(questionNode(good).data.warn).toBeUndefined();

    const oneBranch: any = await svc(JSON.stringify({ branches: [{ subquestion: 'just this', steps: [{ kind: 'ask_ai' }] }] })).planFlow('what happened');
    expect(questionNode(oneBranch).data.planFailed).toBeUndefined();
    expect(oneBranch.nodes.filter((n: any) => n.data.kind === 'subquestion')).toHaveLength(1);
  });
});

describe('the warning actually reaches a human (BEA-1253)', () => {
  it('the run log says it when a run starts on a fallback graph', () => {
    // A thin answer weeks later is unexplainable without this line in the run.
    const runner = readFileSync(join(__dirname, 'flows-runner.service.ts'), 'utf8');
    expect(runner).toContain("nodes.get('question')?.data?.planFailed");
    expect(runner).toContain('PLAN_FAILED_NOTE');
  });

  it('the canvas renders the warning rather than hiding it in the data', () => {
    // Marking the graph and never drawing it would be the same bug in a new place.
    //
    // Checking for the string `data.warn` alone was too weak — it survived me disabling the block
    // with `{false && (`, so the negative control passed and proved nothing. This asserts the node
    // actually renders ON the field, and that the field reaches the DOM.
    const editor = readFileSync(join(__dirname, '../../../web/src/pages/FlowEditor.tsx'), 'utf8');
    expect(editor).toMatch(/\{data\.warn && \(/);
    const block = editor.slice(editor.indexOf('{data.warn && ('), editor.indexOf('{data.warn && (') + 400);
    expect(block).toContain('{data.warn}');
  });

  it('the editor stops toasting success when the plan failed', () => {
    // The ticket's own framing: "the editor's 'Could not plan the flow' toast never fires" — because
    // the endpoint returns 200. A green "Planned the whole flow" on a stand-in is the lie itself.
    const editor = readFileSync(join(__dirname, '../../../web/src/pages/FlowEditor.tsx'), 'utf8');
    const block = editor.slice(editor.indexOf('async function autoPlan()'), editor.indexOf('function toggleEnabled'));
    expect(block).toContain("data?.planFailed");
    expect(block).toMatch(/if \(planFailed\) toast\('error'/);
  });

  it('the note tells you what to DO, not just that something broke', () => {
    expect(FlowsService.PLAN_FAILED_NOTE).toMatch(/Auto-plan/);
    expect(FlowsService.PLAN_FAILED_NOTE).toMatch(/fallback/i);
  });
});

/** BEA-1366: the first live draw-on-save was cut off at the old 2200-token ceiling on both attempts. */
describe('the planner is given room to answer', () => {
  it('asks the flow-plan helper for at least 8000 tokens', async () => {
    const seen: number[] = [];
    const prisma: any = { flow: { findUnique: async () => null } };
    const llm: any = { completeHelper: async (_k: string, _p: string, max: number) => { seen.push(max); return GOOD_PLAN; } };
    const svc2 = new FlowsService(prisma, { list: async () => [] } as any, llm, { get: async () => 'P {{question}} {{tools}} {{skills}}' } as any, undefined);
    await svc2.planFlow('do the thing');
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(8000);
    expect(FlowsService.PLAN_MAX_TOKENS).toBeGreaterThanOrEqual(8000);
  });
});

