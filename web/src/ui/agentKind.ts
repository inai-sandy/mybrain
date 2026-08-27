/**
 * WHAT KIND OF AGENT IS THIS? (BEA-1504)
 *
 * The owner: *"First, we have to formulate a plan for how we have to segregate research agents and
 * the tools agents."* They are genuinely different machines, and until now nothing on screen said
 * which one you were looking at — a goal-built agent even wore the label "chat", the same badge his
 * research agent wears.
 *
 * **Tools agent** — acts in his accounts (Gmail, Notion, Sheets, Reddit, WhatsApp). Runs a small
 * program that was built once and tested. Has a version, checks and a rebuild. Costs credits.
 *
 * **Research agent** — reads the web and writes it up. Thinks fresh every run. Has a flow picture and
 * a search bill. No program, no sources.
 *
 * ONE function, because this decides a badge, a tab, which sections a page shows and which it hides.
 * A second copy of this rule is how this project has repeatedly ended up with two screens disagreeing
 * about the same job.
 */

export type AgentKind = 'tools' | 'research';

/** Our own thinking tools. None of them touches an account the owner has connected. */
const RESEARCH_TOOLS = new Set([
  'web_search',
  'web_read',
  'web_search_meaning',
  'deep_research',
  'ask_ai',
  'search_brain',
  'save_document',
]);

/** Origins that always mean "this one acts on his accounts". */
const TOOL_ORIGINS = new Set(['social', 'goal']);

type AgentLike = {
  origin?: string | null;
  tools?: unknown;
  toolArgs?: unknown;
  useWorker?: boolean | null;
};

/** The tool ids on an agent, however they were stored (array, JSON string, or nothing). */
export function toolIdsOf(a: AgentLike | null | undefined): string[] {
  const raw = a?.tools;
  if (Array.isArray(raw)) return raw.map((t) => String(t));
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Read in this order, most certain first.
 *
 * A `svc:` id is the strongest possible signal — it IS a connected account. Origin comes next
 * because a goal-built job has `tools: []` (its program calls whatever it needs at run time), so the
 * tool list can never identify it. Research tools come third, and anything left over is treated as
 * research: an agent that names no account is one that thinks.
 */
export function agentKind(a: AgentLike | null | undefined): AgentKind {
  const ids = toolIdsOf(a);
  if (ids.some((id) => id.startsWith('svc:'))) return 'tools';

  const hasPinnedArgs = !!a?.toolArgs && typeof a.toolArgs === 'object' && Object.keys(a.toolArgs as object).length > 0;
  if (hasPinnedArgs) return 'tools';

  if (TOOL_ORIGINS.has(String(a?.origin || ''))) return 'tools';

  if (ids.some((id) => RESEARCH_TOOLS.has(id))) return 'research';

  return 'research';
}

/** Does this agent have a compiled program — a version, checks, a rebuild, a rollback? */
export function hasProgram(a: AgentLike | null | undefined): boolean {
  return agentKind(a) === 'tools';
}

export type KindLook = { label: string; title: string; cls: string; emoji: string };

/**
 * How each kind looks. Green for tools (it touches his accounts, the same green the app uses for
 * "this is live"), blue for research (it reads and writes, it changes nothing).
 */
export const KIND: Record<AgentKind, KindLook> = {
  tools: {
    label: '🔧 tools',
    emoji: '🔧',
    title: 'Acts in your accounts — runs a small program that was built and tested',
    cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  },
  research: {
    label: '🔎 research',
    emoji: '🔎',
    title: 'Reads the web and writes it up — thinks fresh every run',
    cls: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  },
};

export const kindLook = (a: AgentLike | null | undefined): KindLook => KIND[agentKind(a)];
