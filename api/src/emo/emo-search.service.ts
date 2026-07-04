import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { AgentService } from '../agent/agent.service';
import { HermesBridgeService } from '../hermes/hermes-bridge.service';
import { EmoCardsService } from './emo-cards.service';

/**
 * EMO (BEA-869) — the Agentic Search lane. A "search" card, once filed by the router, ALWAYS gets a
 * quick clarify first (2–3 questions on the card). When you answer, the search agent runs over your
 * brain + the web and files a CURATED result (headline + ranked findings + sources + next step) —
 * never raw hits. Card-first: works today; the spoken to-and-fro is layered on later via Dograh.
 */
@Injectable()
export class EmoSearchService {
  private readonly log = new Logger('EmoSearch');
  constructor(
    private readonly llm: LlmService,
    private readonly cards: EmoCardsService,
    private readonly agent: AgentService,
    private readonly bridge: HermesBridgeService,
  ) {}

  /** Put 2–3 clarifying questions on a fresh search card (always — the owner values precision). */
  async clarify(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'search') return;
    const query = card.rawTranscript || card.summary || '';
    let questions: string[] = [];
    let options: string[] = [];
    try {
      const raw = await this.llm.complete(
        `The user asked Emo to search their brain + the web for: "${query}".\nWrite 2–3 SHORT clarifying questions that would most change the result (scope · time window · who · done vs pending). Also give 3–5 quick tappable answer chips.\nReply ONLY JSON: {"questions":["…"],"options":["…"]}`,
        300, 'emo-search-clarify',
      );
      const j = JSON.parse((raw || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
      questions = Array.isArray(j.questions) ? j.questions.map((x: any) => String(x)).filter(Boolean).slice(0, 3) : [];
      options = Array.isArray(j.options) ? j.options.map((x: any) => String(x)).filter(Boolean).slice(0, 5) : [];
    } catch { /* fall through to a generic clarify */ }
    const question = questions.length ? questions.join('\n') : 'Anything to narrow it down (scope, dates, who)?';
    if (!options.length) options = ['Search everything'];
    await this.cards.update(cardId, { needsQuestion: question, needsOptions: options, status: 'needs_you' }).catch(() => undefined);
  }

  /** Run the search agent over brain + web and write a curated result onto the card. */
  async run(cardId: string): Promise<void> {
    const card = await this.cards.get(cardId).catch(() => null);
    if (!card || card.lane !== 'search') return;
    const query = card.rawTranscript || card.summary || '';
    const refined = card.needsAnswer ? `\nWhat I clarified: ${card.needsAnswer}` : '';
    const prompt = `Search my second brain AND the web to answer the question below, then return a CURATED answer — NOT raw results.\nFormat: a one-line headline; then the top 3–5 findings, each as a short bullet WITH its source (a URL or the note it came from); then one suggested next step.\n\nQuestion: ${query}${refined}`;
    try {
      const run = await this.agent.createRun({ title: `Emo search: ${(card.summary || query).slice(0, 60)}`, input: prompt });
      await this.bridge.execute(run.id, { prompt, title: `Emo search`, save: false, depth: 'standard' });
      const r: any = await this.agent.getRun(run.id).catch(() => null);
      const text = r?.resultText?.trim();
      if (text) {
        await this.cards.update(cardId, { detail: text, status: 'done', links: [{ kind: 'agent', id: run.id, label: 'Search run' }] });
      } else {
        await this.cards.update(cardId, { status: 'done', error: r?.error || 'no result', detail: 'The search finished but found nothing useful. Try rephrasing.' });
      }
    } catch (e: any) {
      this.log.warn(`search run failed (${cardId}): ${e?.message || e}`);
      await this.cards.update(cardId, { status: 'done', error: String(e?.message || e), detail: 'Sorry — the search failed. You can try again.' }).catch(() => undefined);
    }
  }
}
