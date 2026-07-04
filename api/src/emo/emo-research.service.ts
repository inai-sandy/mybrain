import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { AgentService } from '../agent/agent.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';
import { FlowsService } from '../flows/flows.service';
import { EmoCardsService } from './emo-cards.service';

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
    // Deep tier (default): clarify first, then build the flow once answered.
    if (!card.needsAnswer && card.status !== 'needs_you') {
      await this.clarify(cardId, text);
      return;
    }
    await this.buildFlow(cardId, card, true);
  }

  // ---- Quick research (BEA-871) --------------------------------------------------------------

  private async runQuick(cardId: string, text: string): Promise<void> {
    const query = text.replace(/\bquick\b/i, '').replace(/^\s*research\s*(on)?\s*/i, '').trim() || text;
    const prompt = `Do a QUICK one-pass research pass over my second brain AND the web on the topic below, then return a CONCISE one-screen answer: a one-line headline, 4–6 tight bullet findings each with a source, and one "next step". Keep it short — this is the fast tier.\n\nTopic: ${query}`;
    try {
      const run: any = await this.agent.createRun({ title: `Emo quick research: ${query.slice(0, 50)}`, input: prompt });
      await this.bridge.execute(run.id, { prompt, title: 'Emo quick research', save: false, depth: 'standard' });
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
    const flow = await this.createResearchFlow(base);
    if (!flow) return;
    await this.cards.update(cardId, {
      links: [...(card.links || []), { kind: 'flow', id: flow.flowId, label: `Open deep flow: ${flow.topic}` }],
      detail: `${card.detail || ''}\n\n---\n**Went deeper →** a research flow "${flow.topic}" has been built and saved (not run). Open it, tweak, and run when ready.`,
    }).catch(() => undefined);
  }

  // ---- Deep research (BEA-870) ---------------------------------------------------------------

  private async clarify(cardId: string, topic: string): Promise<void> {
    let questions: string[] = [];
    let options: string[] = [];
    try {
      const raw = await this.llm.complete(
        `The user wants deep research: "${topic}".\nWrite 2–3 SHORT questions that would most shape the research (angle · depth · sources · time frame). Also 3–5 quick answer chips.\nReply ONLY JSON: {"questions":["…"],"options":["…"]}`,
        300, 'emo-research-clarify',
      );
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      questions = Array.isArray(j.questions) ? j.questions.map((x: any) => String(x)).filter(Boolean).slice(0, 3) : [];
      options = Array.isArray(j.options) ? j.options.map((x: any) => String(x)).filter(Boolean).slice(0, 5) : [];
    } catch { /* generic fallback */ }
    await this.cards.update(cardId, {
      needsQuestion: questions.length ? questions.join('\n') : 'Any angle, depth, or time frame to focus the research?',
      needsOptions: options.length ? options : ['Broad overview', 'Just the essentials'],
      status: 'needs_you',
    }).catch(() => undefined);
  }

  /** Create + pre-plan (but do NOT run) a research flow from a brief. Returns {flowId, topic}. */
  private async createResearchFlow(base: string): Promise<{ flowId: string; topic: string; question: string } | null> {
    let topic = base.replace(/^\s*(deep\s+)?research\s*(on)?\s*/i, '').slice(0, 60).trim() || 'Research';
    let question = base;
    try {
      const raw = await this.llm.complete(
        `Turn this spoken request into a clean research brief. Reply ONLY JSON {"topic":"3-6 word title","question":"one clear research question/brief"}.\nRequest: "${base}"`,
        300, 'emo-research-brief',
      );
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (j.topic) topic = String(j.topic).slice(0, 60).trim();
      if (j.question) question = String(j.question).trim();
    } catch { /* keep fallbacks */ }
    try {
      const flow: any = await this.flows.create({ name: `Research: ${topic}`, question });
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
