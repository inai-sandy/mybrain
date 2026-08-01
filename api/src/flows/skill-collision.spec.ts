import { FlowsService } from './flows.service';
import { PromptsService } from '../prompts/prompts.service';

/**
 * BEA-1250 — a skill named "deep-research" hijacked the research step.
 *
 * The owner imported a Claude-Code skill called `deep-research`. The auto-planner, told to use a
 * skill when it is an OBVIOUS fit, picked it for a research request — the name made it the most
 * obvious fit on the list. But skills run on the Codex engine, which cannot search the web
 * (BEA-1202, by design) and cannot write files. On the real "Meshtastic Practicality Report" run
 * the branch came back with a 122-character refusal, counted as done, and a third of the research
 * vanished — while the real deep_research TOOL sat unused.
 *
 * Two locks: the planner is told skills cannot research, and a plan that still names a skill whose
 * words match a real tool is built as that tool.
 */

const catalog = {
  catalog: async () => ({
    groups: [],
    tools: [
      { id: 'web_search', name: 'Web search', group: 'Web', description: 'keyword search', connected: true, kind: 'tool' },
      { id: 'deep_research', name: 'Deep research', group: 'Web', description: 'digs properly', connected: true, kind: 'tool' },
      { id: 'gmail', name: 'Gmail', group: 'Google', description: 'read email', connected: true, kind: 'tool' },
    ],
  }),
} as any;

/** A skills registry containing the owner's real trap: a deployed skill called "deep-research". */
const skillsSvc = {
  list: async () => [
    { id: 'sk-trap', title: 'deep-research', description: 'Run a deep research loop', deployedTo: ['sandy'] },
    { id: 'sk-ui', title: 'ui-ux-pro-max-skill', description: 'Design polish', deployedTo: ['sandy'] },
    { id: 'sk-gmail', title: 'Gmail', description: 'My own email triage rules', deployedTo: ['sandy'] },
  ],
} as any;

function svc(plan: any, seen: string[] = []) {
  const llm = { complete: async (p: string) => { seen.push(p); return JSON.stringify(plan); } };
  const prompts = { get: async () => 'Q={{question}} T={{tools}} S={{skills}}' };
  return new FlowsService({} as any, skillsSvc, llm as any, prompts as any, catalog);
}

describe('a skill that shares a tool\'s name becomes that tool (BEA-1250)', () => {
  it('remaps skill:deep-research to the deep_research tool — the exact live failure', async () => {
    const g = await svc({
      branches: [{ subquestion: 'range in dense cities', steps: [{ kind: 'skill', id: 'sk-trap' }, { kind: 'ask_ai' }] }],
      merge: 'ai',
    }).planFlow('how practical is Meshtastic');
    const skills = g.nodes.filter((n: any) => n.data?.kind === 'skill');
    const tools = g.nodes.filter((n: any) => n.data?.refId === 'deep_research');
    expect(skills).toHaveLength(0);
    expect(tools).toHaveLength(1);
    expect(tools[0].data.kind).toBe('tool');
    expect(tools[0].data.label).toBe('Deep research');
  });

  it('the swap is written on the node, never silent', async () => {
    // Quiet substitutions are the bug class this codebase keeps paying for (BEA-1241, BEA-1248).
    // The canvas must SAY a skill was swapped for the tool, so the owner can see what happened.
    const g = await svc({
      branches: [{ subquestion: 'q', steps: [{ kind: 'skill', id: 'sk-trap' }] }],
      merge: 'ai',
    }).planFlow('research something');
    const node = g.nodes.find((n: any) => n.data?.refId === 'deep_research');
    expect(node.data.sub).toContain('deep-research');
    expect(node.data.sub).toContain('skill');
    expect(node.data.sub).toContain('cannot search the web');
  });

  it('a skill that collides with a NON-web tool is NOT remapped — the rule is about web work only', async () => {
    // A skill called "Gmail" doing its own triage is a legitimate, deliberate choice. The engine
    // CAN run it (no web search needed) — overriding it on a naming coincidence would discard the
    // planner's real intent. Only web-tool collisions are guaranteed traps.
    const g = await svc({
      branches: [{ subquestion: 'triage my inbox', steps: [{ kind: 'skill', id: 'sk-gmail' }, { kind: 'ask_ai' }] }],
      merge: 'ai',
    }).planFlow('sort my email');
    const skills = g.nodes.filter((n: any) => n.data?.kind === 'skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].data.refId).toBe('sk-gmail');
    expect(g.nodes.some((n: any) => n.data?.refId === 'gmail' && n.data?.kind === 'tool')).toBe(false);
  });

  it('a skill with its own name stays a skill — only collisions are remapped', async () => {
    const g = await svc({
      branches: [{ subquestion: 'polish the page', steps: [{ kind: 'skill', id: 'sk-ui' }, { kind: 'ask_ai' }] }],
      merge: 'ai',
    }).planFlow('make it pretty');
    const skills = g.nodes.filter((n: any) => n.data?.kind === 'skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].data.refId).toBe('sk-ui');
  });

  it('matches across separators and case — "Deep Research", "deep_research", "deep-research"', () => {
    const norm = (FlowsService as any).normName as (s: string) => string;
    expect(norm('Deep Research')).toBe(norm('deep_research'));
    expect(norm('deep-research')).toBe(norm('deep_research'));
    expect(norm(' Deep--Research ')).toBe('deep_research');
    // and non-collisions stay distinct
    expect(norm('deep-research')).not.toBe(norm('web_search'));
  });
});

describe('the planner is told skills cannot research (BEA-1250)', () => {
  function promptsSvc() {
    const prisma: any = {
      setting: {
        findUnique: async () => null,
        upsert: async () => ({}),
        deleteMany: async () => ({ count: 0 }),
      },
    };
    return new PromptsService(prisma);
  }

  it('the default flow.plan prompt forbids skills for research, and says why', async () => {
    const tpl = await promptsSvc().get('flow.plan');
    expect(tpl).toMatch(/NEVER pick a skill\s*\nto research|NEVER pick a skill to research/);
    expect(tpl).toContain('NO web access');
    // The reason matters: the name is exactly what fooled it.
    expect(tpl).toContain('whatever its name suggests');
  });
});
