import { Injectable, Logger } from '@nestjs/common';
import { ToolCatalogService } from './tool-catalog.service';
import { ToolKnowledge, ToolKnowledgeService } from './tool-knowledge.service';
import { isServiceToolId } from './service-provider';

/** How many actions one search may hand back. Narrowing, not browsing. */
export const FIND_MAX = 25;

export type ServiceLine = { slug: string; name: string; actions: number };
export type FoundAction = { id: string; name: string; description?: string; risky?: boolean; retired?: boolean };

/**
 * Three questions the builder may ask about the toolbox (BEA-1417).
 *
 * ## Why this exists
 *
 * Until now **I** chose which tools the builder was told about: `tool-shortlist.ts` ranks by keyword
 * and hands over about fifty, decided before anybody has read anything. If a job needs an action my
 * ranking did not surface, it is not there — and nothing can know what it is missing. That is the
 * last real cause of a wrong agent still sitting on my side of the line, and the owner named it:
 * *"when it has complete information, it can easily build the agent."*
 *
 * ## Why a lookup and not a RAG
 *
 * He proposed putting the tools in a RAG. The instinct is right and the store is wrong. A RAG
 * answers with *the most similar thing*, and tool schemas are exact facts, not fuzzy text. "Send a
 * message" is similar to `send_message`, `send_template`, `send_list`, `delete_message` and
 * `send_rfq` — and picking the nearest is how an agent deletes something. We have already met this
 * wall: Composio's own list search is not semantic and would run the wrong action.
 *
 * Complete information was never the problem. 1,209 services with full schemas are already here.
 * The problem was that nothing could **reach** them.
 *
 * ## The rule that makes it safe
 *
 * **Search narrows. Only an exact fetch may be acted on.** `findActions` answers names and one-line
 * descriptions — enough to choose what to look at properly — and never enough to plan on. A plan may
 * only name an id that was fetched in full by `getAction`, so nothing is ever dispatched on a
 * similarity score. The can't-undo gate still sits in front of every write, which matters more now
 * that a model can find `delete_template` on its own.
 */
@Injectable()
export class ToolLookupService {
  private readonly log = new Logger('ToolLookup');

  constructor(
    private readonly catalog: ToolCatalogService,
    // Optional + LAST — spec harnesses build this positionally with fewer args.
    private readonly knowledge?: ToolKnowledgeService,
  ) {}

  /**
   * How a card is written out for a model. Registered at boot by whoever owns the prompt words
   * (`AgentModule`), the same seam `setFlowSync`/`setBudget` already use — this module may not
   * import the agent module.
   */
  private write?: (card: ToolKnowledge) => string;
  setCardWriter(fn: (card: ToolKnowledge) => string) {
    this.write = fn;
  }

  /** What is connected, and how much each one has. The starting point for any search. */
  async services(): Promise<ServiceLine[]> {
    const cat: any = await this.catalog?.catalog?.().catch(() => null);
    const seen = new Map<string, ServiceLine>();
    for (const t of (cat?.tools || []) as any[]) {
      if (!t?.connected || !isServiceToolId(t.id)) continue;
      const slug = String(t.service || '').toLowerCase();
      if (!slug) continue;
      const line = seen.get(slug) || { slug, name: pretty(slug), actions: 0 };
      line.actions += 1;
      seen.set(slug, line);
    }
    return [...seen.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  }

  /**
   * Which actions of one service look like this. **Narrowing only** — the answer carries names and
   * one-line descriptions, never a schema, and nothing here may be planned on.
   */
  async findActions(service: string, words: string): Promise<FoundAction[]> {
    const slug = String(service || '').trim().toLowerCase();
    if (!slug) return [];
    const cat: any = await this.catalog?.catalog?.().catch(() => null);
    const all = ((cat?.tools || []) as any[]).filter((t) => isServiceToolId(t?.id) && String(t.service || '').toLowerCase() === slug);
    const terms = String(words || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
    const score = (t: any) => {
      if (!terms.length) return 1;
      const hay = `${t.id} ${t.name} ${t.description || ''}`.toLowerCase();
      let n = 0;
      for (const w of terms) if (hay.includes(w)) n += hay.includes(` ${w} `) || String(t.id).toLowerCase().includes(w) ? 2 : 1;
      return n;
    };
    return all
      .map((t) => ({ t, n: score(t) }))
      .filter((x) => x.n > 0)
      // A retired action is still real and still callable; it just goes last, as everywhere else.
      .sort((a, b) => b.n - a.n || Number(!!a.t.retired) - Number(!!b.t.retired) || String(a.t.id).localeCompare(String(b.t.id)))
      .slice(0, FIND_MAX)
      .map(({ t }) => ({
        id: String(t.id),
        name: String(t.name || t.id),
        description: t.description ? String(t.description).slice(0, 200) : undefined,
        ...(t.risky ? { risky: true } : {}),
        ...(t.retired ? { retired: true } : {}),
      }));
  }

  /**
   * ONE action, in full — parameters, types, defaults, enums, what its answers look like, how it
   * pages, what it costs, whether it is working, and **what using it has taught us**.
   *
   * This is the only answer a plan may be built on.
   */
  async getAction(actionId: string): Promise<{ id: string; text: string } | null> {
    const id = String(actionId || '').trim();
    if (!isServiceToolId(id)) return null;
    const card = await this.knowledge?.card?.(id).catch(() => null);
    if (!card) return null;
    // The card, written out by whoever asked — `cardText` lives with the builder's prompt-writing,
    // and this service must not depend on the agent module.
    return { id, text: this.write ? this.write(card) : JSON.stringify(card) };
  }
}

/** What the builder is told it may ask. Kept beside the service so the words and the code agree. */
export const LOOKUP_TEXT = `LOOKING UP A TOOL

You are not limited to the tools listed above. Ask, instead of guessing:

  {"lookup": {"what": "services"}}                                  what is connected
  {"lookup": {"what": "actions", "service": "gmail", "words": "send a draft"}}
  {"lookup": {"what": "action", "actionId": "svc:gmail.send_email"}}   ONE action, in full

The rule: **a search only narrows.** The names it gives back are enough to choose what to look at
properly, and never enough to plan on. Fetch an action in full before you use it in a plan — a plan
that names an id you never fetched is refused.

Fetch the ones you are seriously considering. Do not fetch twenty to browse.`;

/** Did the model ask to look something up? */
export function lookupRequestOf(g: any): { what: 'services' | 'actions' | 'action'; service?: string; words?: string; actionId?: string } | null {
  const l = g?.lookup;
  if (!l || typeof l !== 'object') return null;
  const what = String(l.what || '').trim().toLowerCase();
  if (what === 'services') return { what: 'services' };
  if (what === 'actions') return { what: 'actions', service: String(l.service || '').trim(), words: String(l.words || '').trim() };
  if (what === 'action') return { what: 'action', actionId: String(l.actionId || '').trim() };
  return null;
}

/** The answer, as the model reads it back. */
export function lookupText(
  ask: { what: string; service?: string; words?: string; actionId?: string },
  out: { services?: ServiceLine[]; actions?: FoundAction[]; action?: { id: string; text: string } | null },
): string {
  if (ask.what === 'services') {
    const list = out.services || [];
    if (!list.length) return 'LOOKUP — nothing is connected yet. He has to connect a service in /tools first.';
    return `LOOKUP — connected services:\n${list.map((s) => `- ${s.slug} (${s.name}) — ${s.actions} actions`).join('\n')}`;
  }
  if (ask.what === 'actions') {
    const list = out.actions || [];
    if (!list.length) return `LOOKUP — nothing in "${ask.service}" matches "${ask.words}". Try other words, or ask for the service list.`;
    return [
      `LOOKUP — ${list.length} action${list.length === 1 ? '' : 's'} in "${ask.service}" matching "${ask.words}" (names only — fetch one in full before planning on it):`,
      ...list.map((a) => `- ${a.id} — ${a.name}${a.description ? `: ${a.description}` : ''}${a.risky ? ' [needs his approval to run]' : ''}${a.retired ? ' [retired]' : ''}`),
    ].join('\n');
  }
  if (!out.action) return `LOOKUP — there is no action called "${ask.actionId}". Search the service first.`;
  return `LOOKUP — ${out.action.id}, in full:\n${out.action.text}`;
}

/** `google_sheets` → `Google Sheets`. The catalog has no display name on an action row. */
function pretty(slug: string): string {
  return String(slug || '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
