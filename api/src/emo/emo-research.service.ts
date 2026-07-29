import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { AgentService } from '../agent/agent.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';
import { FlowsService } from '../flows/flows.service';
import { EmoCardsService } from './emo-cards.service';
import { PromptsService } from '../prompts/prompts.service';
import { AgentAreasService } from '../agent/agent-areas.service';
import { FlowRunnerService } from '../flows/flows-runner.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';

/**
 * EMO Research lanes — the research ladder's two upper tiers:
 *  • Deep (BEA-870, the DEFAULT for "research X"): clarify → build & SAVE a Flow (don't run it).
 *  • Quick (BEA-871, opt-in with the word "quick"): run a one-pass brain+web synthesis NOW → concise
 *    card, with a "Go deeper" that converts it into a deep-research flow seeded with the same brief.
 */
@Injectable()
export class EmoResearchService {
  private readonly log = new Logger('EmoResearch');
  constructor(
    private readonly llm: LlmService,
    private readonly cards: EmoCardsService,
    private readonly flows: FlowsService,
    private readonly agent: AgentService,
    private readonly bridge: HermesBridgeService,
    private readonly prompts: PromptsService,
    // Optional + LAST — spec files construct positionally.
    private readonly areas?: AgentAreasService,
    private readonly runner?: FlowRunnerService,
    private readonly catalog?: ToolCatalogService,
  ) {}

  private isQuick(text: string): boolean {
    return /\bquick\b/i.test(text || '');
  }

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'research') return;
    const text = card.rawTranscript || card.summary || '';

    // Quick tier (opt-in): run now, no clarify.
    if (this.isQuick(text) && !card.needsAnswer) {
      await this.runQuick(cardId, text);
      return;
    }
    // Deep tier (default, BEA-1175): NO questions. The Research Agent already holds how the owner
    // likes research done — asking "any angle or time frame?" every single time was asking twice.
    // It picks its own tools, builds the flow under the Research Agent, and runs it.
    await this.runUnderResearchAgent(cardId, text);
  }

  // ---- Quick research (BEA-871) --------------------------------------------------------------

  private async runQuick(cardId: string, text: string): Promise<void> {
    const query = text.replace(/^.*?\bresearch\b\s*(on|about|into)?\s*/i, '').trim() || text;
    const quickTmpl = await this.prompts.get('emo.research');
    const prompt = `${quickTmpl}\n\nTopic: ${query}`;
    try {
      const run: any = await this.agent.createRun({ title: `Emo quick research: ${query.slice(0, 50)}`, input: prompt });
      // allowAsk:false — a card has no UI to surface a mid-run question (BEA-1191). Without this the
      // run could park, the card would read the empty result and say "found nothing useful", and a
      // real question would sit waiting somewhere the card never points to.
      await this.bridge.execute(run.id, { prompt, title: 'Emo quick research', save: false, depth: 'quick', allowAsk: false });
      const r: any = await this.agent.getRun(run.id).catch(() => null);
      const out = r?.resultText?.trim();
      await this.cards.update(cardId, {
        summary: `Quick research: ${query.slice(0, 60)}`,
        detail: out || 'The quick research finished but found nothing useful. Try “Go deeper”.',
        // NB: no flow link yet — that's how the card offers "Go deeper".
        links: [{ kind: 'agent', id: run.id, label: 'Quick research run' }],
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`quick research failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'done', error: String(e?.message || e), summary: `Quick research: ${query.slice(0, 60)}`, detail: 'Sorry — the quick research failed. You can try “Go deeper”.' }).catch(() => undefined);
    }
  }

  /** "Go deeper" — turn a finished quick card into a saved deep-research flow (same brief). */
  async goDeeper(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'research') return;
    if ((card.links || []).some((l: any) => l.kind === 'flow')) return; // already went deep
    const base = card.rawTranscript || card.summary || '';
    // Same lane, same rule (BEA-1175): never a standalone flow. Go deeper adopts the Research Agent.
    const flow = await this.createResearchFlow(base, await this.researchJobFor(base));
    if (!flow) return;
    await this.cards.update(cardId, {
      links: [...(card.links || []), { kind: 'flow', id: flow.flowId, label: `Open deep flow: ${flow.topic}` }],
      detail: `${card.detail || ''}\n\n---\n**Went deeper →** a research flow "${flow.topic}" has been built and saved (not run). Open it, tweak, and run when ready.`,
    }).catch(() => undefined);
  }

  // ---- Voice research, hands-off (BEA-1175) ----------------------------------------------------

  /**
   * The kit a spoken research gets when nothing smarter is available.
   *
   * NO brain tool here on purpose (BEA-1184): the owner does not want his own notes searched as a
   * side effect of asking for research — "if required, I'll add it manually". They stay one tick
   * away in the picker.
   */
  private static DEFAULT_KIT = ['web_search', 'web_read', 'save_document'];

  /** Tools that read the owner's own material — never chosen on his behalf. */
  private static BRAIN_TOOLS = new Set(['search_brain', 'search_rag', 'fetch_document', 'remember']);

  /** Did he actually ask for his own notes to be involved? */
  private static wantsBrain(text: string): boolean {
    return /\b(my|our)\s+(notes?|brain|documents?|memory|memories|writing|journal)\b|\bwhat did i\b|\bi wrote\b|\bsecond brain\b/i.test(text || '');
  }

  /** Choose the tools for a spoken topic — from the connected catalog, never anything else. */
  private async pickTools(text: string): Promise<string[]> {
    const cat = await this.catalog?.catalog().catch(() => null);
    const connected = (cat?.tools || []).filter((t: any) => t.kind === 'tool' && t.connected);
    // If the catalog can't be reached we still hand back the plain research kit (BEA-1191). Returning
    // nothing looked safe but did the opposite: an empty list means "no job-level toolbox", so the job
    // fell back to the agent's — or to no restriction at all, which can include the brain tools that
    // BEA-1184 says are never chosen automatically. A failure has to narrow, never widen.
    if (!connected.length) return [...EmoResearchService.DEFAULT_KIT];
    const wantsBrain = EmoResearchService.wantsBrain(text);
    // Offer brain tools to the picker ONLY when he asked for his own material (BEA-1184).
    const offerable = connected.filter((t: any) => wantsBrain || !EmoResearchService.BRAIN_TOOLS.has(t.id));
    const ok = new Set(offerable.map((t: any) => t.id));
    const fallback = EmoResearchService.DEFAULT_KIT.filter((id) => ok.has(id));
    try {
      const list = offerable.map((t: any) => `- ${t.id}: ${t.name} — ${t.description}`).join('\n');
      const out = await this.llm.complete(
        `Pick the tools an assistant needs to research this properly. Use ONLY ids from the list.\n\nWhat was asked:\n"${text.slice(0, 500)}"\n\nTools:\n${list}\n\nReply with ONLY a JSON array of ids, e.g. ["web_search","save_document"]. Include a way to search the web, a way to read sources, and a way to save the result unless the request clearly does not need it. Do NOT pick anything that reads the owner's own notes or documents unless he explicitly asked for them.`,
        200,
        'emo-research-tools',
      );
      const m = (out || '').match(/\[[\s\S]*\]/);
      const ids = m ? JSON.parse(m[0]) : [];
      const picked = (Array.isArray(ids) ? ids : []).map((x: any) => String(x)).filter((x: string) => ok.has(x));
      return picked.length ? picked : fallback;
    } catch { return fallback; }
  }

  /**
   * Speak it, and it is done. Lands in the Research Agent as a voice job, picks its own tools,
   * draws a flow and RUNS it — no question is ever asked (BEA-1175).
   */
  private async runUnderResearchAgent(cardId: string, text: string): Promise<void> {
    if (!this.areas || !this.runner) {
      // Should be impossible — EmoModule provides both. If a future refactor breaks that export we
      // fall back to the old standalone flow, which violates "never standalone", so say so loudly.
      this.log.warn('voice research fell back to a standalone flow — AgentAreasService/FlowRunnerService not injected');
      await this.buildFlow(cardId, await this.cards.get(cardId), true);
      return;
    }
    try {
      const { id: areaId, created: madeAgent } = await this.areas.ensureResearchAgent();
      const [{ topic, question }, tools] = await Promise.all([this.briefFor(text), this.pickTools(text)]);

      // The job first, so the flow can be planned INSIDE its toolbox in one pass.
      const job: any = await this.agent.createAgent({
        areaId,
        name: topic.slice(0, 120),
        icon: '🔬',
        description: 'Asked for by voice',
        prompt: question,
        defaultDepth: 'deep',
        origin: 'voice',
        tools,
      } as any);

      const jobLink = { kind: 'agent', id: job.id, label: `Open the job: ${topic}` };
      const madeNote = madeAgent ? 'I set up a Research Agent for you and filed this under it.' : 'Filed under your Research Agent.';

      const flow: any = await this.flows.create({ name: `${topic} flow`, question, agentId: job.id }).catch(() => null);
      const brief = flow?.id ? { flowId: flow.id as string } : null;
      if (!brief) {
        // The job is real; only the picture failed. Land the card somewhere honest rather than
        // leaving it "cooking" forever with nothing coming.
        await this.cards.update(cardId, {
          summary: `Research job ready: ${topic}`,
          detail: `${madeNote} I couldn't draw its steps, so it hasn't started — open the job and press Run.\n\n> ${question}`,
          links: [jobLink],
          status: 'done',
        }).catch(() => undefined);
        return;
      }
      await this.flows.planAndSave(brief.flowId).catch(() => undefined);

      await this.cards.update(cardId, {
        summary: `Researching: ${topic}`,
        detail: `${madeNote} Running now — no questions asked.\n\n> ${question}`,
        links: [jobLink, { kind: 'flow', id: brief.flowId, label: 'See the steps' }],
        status: 'cooking',
      }).catch(() => undefined);

      // Full depth, as the owner chose: it runs itself, nothing to press.
      const started = await this.runner.start(brief.flowId).catch((e: any) => { this.log.warn(`voice research run failed: ${e?.message || e}`); return null; });
      await this.cards.update(cardId, {
        status: 'done',
        summary: started?.runId ? `Researching: ${topic}` : `Research job ready: ${topic}`,
        detail: started?.runId
          ? `${madeNote} Running now — no questions asked.\n\n> ${question}`
          : `${madeNote} It could not start — open the job and press Run.\n\n> ${question}`,
        links: [jobLink, ...(started?.runId ? [{ kind: 'flowRun', id: started.runId, label: 'Watch it work' }] : [{ kind: 'flow', id: brief.flowId, label: 'See the steps' }])],
      }).catch(() => undefined);
    } catch (e: any) {
      this.log.warn(`voice research failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I could not set that research up. Reword the topic?' }).catch(() => undefined);
    }
  }

  // ---- Deep research (BEA-870) ---------------------------------------------------------------

  // The old clarify() step is GONE (BEA-1175). It asked "any angle, depth, or time frame?" on every
  // single spoken research, even though the Research Agent already holds how the owner likes
  // research done — it was asking the same question twice. Its prompt template `emo.researchClarify`
  // is now unused too.

  /** Topic + a proper research question from what was said. Creates nothing. */
  private async briefFor(base: string): Promise<{ topic: string; question: string }> {
    let topic = base.replace(/^.*?\bresearch\b\s*(on|about|into)?\s*/i, '').slice(0, 60).trim() || 'Research';
    let question = base;
    try {
      const briefTmpl = await this.prompts.get('emo.researchBrief');
      const raw = await this.llm.complete(briefTmpl.replace(/\{\{request\}\}/g, base), 300, 'emo-research-brief');
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (j.topic) topic = String(j.topic).slice(0, 60).trim();
      if (j.question) question = String(j.question).trim();
    } catch { /* keep fallbacks */ }
    return { topic, question };
  }

  /** A job under the Research Agent to hang a flow off — null if areas aren't available. */
  private async researchJobFor(base: string): Promise<string | null> {
    if (!this.areas) return null;
    try {
      const { id: areaId } = await this.areas.ensureResearchAgent();
      const topic = base.replace(/^.*?\bresearch\b\s*(on|about|into)?\s*/i, '').slice(0, 60).trim() || 'Research';
      const job: any = await this.agent.createAgent({ areaId, name: topic.slice(0, 120), icon: '🔬', description: 'Asked for by voice', prompt: base, defaultDepth: 'deep', origin: 'voice' } as any);
      return job?.id || null;
    } catch { return null; }
  }

  /** Create + pre-plan (but do NOT run) a research flow from a brief. Returns {flowId, topic}. */
  private async createResearchFlow(base: string, agentId?: string | null): Promise<{ flowId: string; topic: string; question: string } | null> {
    let topic = base.replace(/^.*?\bresearch\b\s*(on|about|into)?\s*/i, '').slice(0, 60).trim() || 'Research';
    let question = base;
    try {
      const briefTmpl = await this.prompts.get('emo.researchBrief');
      const raw = await this.llm.complete(
        briefTmpl.replace(/\{\{request\}\}/g, base),
        300, 'emo-research-brief',
      );
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (j.topic) topic = String(j.topic).slice(0, 60).trim();
      if (j.question) question = String(j.question).trim();
    } catch { /* keep fallbacks */ }
    try {
      const flow: any = await this.flows.create({ name: `Research: ${topic}`, question, ...(agentId ? { agentId } : {}) });
      await this.flows.planAndSave(flow.id).catch((e) => this.log.warn(`planAndSave failed: ${e?.message || e}`));
      return { flowId: flow.id, topic, question };
    } catch (e: any) {
      this.log.warn(`createResearchFlow failed: ${e?.message || e}`);
      return null;
    }
  }

  private async buildFlow(cardId: string, card: any, replaceCard: boolean): Promise<void> {
    const base = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    const flow = await this.createResearchFlow(base);
    if (!flow) {
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn’t build the research flow. Reword the topic?' }).catch(() => undefined);
      return;
    }
    if (replaceCard) {
      await this.cards.update(cardId, {
        summary: `Research flow ready: ${flow.topic}`,
        detail: `I built and **saved** a research flow from your brief — it is NOT running yet.\n\n> ${flow.question}\n\nOpen it, tweak the branches, and run it whenever you're ready (you control the expensive part).`,
        links: [{ kind: 'flow', id: flow.flowId, label: `Open flow: ${flow.topic}` }],
        status: 'done',
      }).catch(() => undefined);
    }
  }
}
