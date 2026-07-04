import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { FlowsService } from '../flows/flows.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-870) — the Deep Research lane (the DEFAULT for "research X"). It clarifies first (2–3
 * questions on the card — the owner values control), then turns the brief into a research FLOW in
 * My Brain's Flows canvas and SAVES it (pre-planned branches) WITHOUT running it. The card links
 * straight to the saved flow; the owner tweaks and runs the expensive part themselves.
 * (Quick Research — the run-now tier — is BEA-871.)
 */
@Injectable()
export class EmoResearchService {
  private readonly log = new Logger('EmoResearch');
  constructor(
    private readonly llm: LlmService,
    private readonly cards: EmoCardsService,
    private readonly flows: FlowsService,
  ) {}

  async handle(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'research') return;
    // Deep research clarifies first; once answered (or on retry), build the flow.
    if (!card.needsAnswer && card.status !== 'needs_you') {
      await this.clarify(cardId, card.rawTranscript || card.summary || '');
      return;
    }
    await this.buildFlow(cardId, card);
  }

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

  private async buildFlow(cardId: string, card: any): Promise<void> {
    const base = [card.rawTranscript || card.summary || '', card.needsAnswer].filter(Boolean).join('. ').trim();
    try {
      let topic = (card.summary || base).replace(/^research[:\s-]*/i, '').slice(0, 60).trim() || 'Research';
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

      const flow: any = await this.flows.create({ name: `Research: ${topic}`, question });
      // Pre-plan the branches; if planning fails the flow is still saved (an empty, editable canvas).
      await this.flows.planAndSave(flow.id).catch((e) => this.log.warn(`planAndSave failed: ${e?.message || e}`));

      await this.cards.update(cardId, {
        summary: `Research flow ready: ${topic}`,
        detail: `I built and **saved** a research flow from your brief — it is NOT running yet.\n\n> ${question}\n\nOpen it, tweak the branches, and run it whenever you're ready (you control the expensive part).`,
        links: [{ kind: 'flow', id: flow.id, label: `Open flow: ${topic}` }],
        status: 'done',
      });
    } catch (e: any) {
      this.log.warn(`research lane failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'needs_you', needsQuestion: 'I couldn’t build the research flow. Reword the topic?', error: String(e?.message || e) }).catch(() => undefined);
    }
  }
}
