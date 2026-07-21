import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { ExploreService } from '../explore/explore.service';
import { EmoCardsService } from './emo-cards.service';

export type AskTurn = { role: 'user' | 'emo'; text: string };
export type AskOffer = { spoken: string; action: string };
export type AskResult = { mode: 'clarify'; question: string } | { mode: 'answer'; summary: string; cardId: string; offer?: AskOffer };

/**
 * EMO Ask (BEA-890) — the voice Ask. ONE round trip: answer straight away from the brain, FILE a
 * Search card (the receipt — full answer + detail), and return a SHORT spoken summary. The voice
 * speaks the summary only; it never reads the card.
 *
 * It used to ask a clarifying question first — a whole extra brain search + LLM call + a round trip
 * the owner had to answer, on EVERY question. Removed (BEA-1012); take the best shot immediately.
 * The follow-up "want me to do X?" offer is no longer computed here either — it made the owner wait
 * for an LLM call AFTER his answer already existed. The client asks for it separately while it's
 * speaking (`offerFor`).
 */
@Injectable()
export class EmoAskService {
  private readonly log = new Logger('EmoAsk');
  constructor(
    private readonly llm: LlmService,
    private readonly memory: MemoryService,
    private readonly explore: ExploreService,
    private readonly cards: EmoCardsService,
  ) {}

  async ask(input: { question: string; history?: AskTurn[]; sessionContext?: string; web?: 'on' | 'off' | 'auto'; direct?: boolean; ragOnly?: boolean }): Promise<AskResult> {
    const history = (input.history || []).filter((t) => t && t.text && (t.role === 'user' || t.role === 'emo'));
    const userText = (input.question || '').trim();
    if (!userText && !history.length) return { mode: 'clarify', question: 'What would you like to know, Sandy?' };

    // Answer from the whole brain, then file the Search card. No clarifying round and no grounding
    // search any more (BEA-1012) — both were pure latency before the owner heard anything.
    const userTurns = [...history.filter((t) => t.role === 'user').map((t) => t.text), userText].filter(Boolean);
    const baseQ = userTurns.length > 1 ? `${userTurns[0]} — specifically: ${userTurns.slice(1).join('; ')}` : userTurns[0] || userText;
    // Send the QUESTION only. Appending the earlier-session text used to drag the search embedding
    // away from what he actually asked (BEA-1011); Explore now does its own understanding step.
    const retrievalQ = baseQ;
    // EMO answers from the local RAG store only (BEA-1011, owner's call) — SuperMemory's off-topic
    // hits were polluting answers and adding a slow cloud round-trip. Callers can still opt out.
    const ragOnly = input.ragOnly !== false;
    const ans = await this.explore.ask(retrievalQ, { web: input.web || 'auto', withSummary: true, ragOnly }).catch(() => ({ answer: '', sources: [] as any[], matches: 0, usedWeb: false, summary: undefined as string | undefined }));
    const answer = (ans.answer || '').trim() || "I couldn't find anything about that in your brain yet.";
    // one call already gave us the spoken summary; fall back to the first sentence (no extra model call).
    const summary = ((ans as any).summary || '').trim() || (answer.split(/(?<=[.!?])\s/)[0] || answer).slice(0, 200);
    // A COMPLETE card: the question + the full answer (inline [n] citations become tappable chips),
    // with the cited sources stored STRUCTURED on the card so app + web render them as accordions.
    const sources = (ans.sources || []) as any[];
    const detail = `**${baseQ}**\n\n${answer}`;
    const card = await this.cards.create({ lane: 'search', status: 'done', summary, detail, rawTranscript: baseQ, sources });
    // The "want me to do X?" offer is NOT computed here — it needed another LLM round trip after the
    // answer already existed, so it just made him wait. The client fetches it while it speaks. (BEA-1012)
    return { mode: 'answer', summary, cardId: (card as any).id };
  }

  /**
   * The follow-up offer for an answer that was already spoken (BEA-1012). The client calls this while
   * the voice is speaking the summary, so the LLM round trip costs the owner nothing.
   */
  async offerFor(cardId: string): Promise<{ offer?: AskOffer }> {
    const card: any = await this.cards.get(cardId).catch(() => null);
    if (!card) return {};
    const question = String(card.rawTranscript || '');
    const detail = String(card.detail || '');
    const answer = detail.replace(/^\*\*[\s\S]*?\*\*\s*/, '').trim() || detail;
    if (!answer) return {};
    const offer = await this.actionOffer(answer, question).catch(() => undefined);
    return { offer };
  }

  /** After answering, spot ONE genuinely useful next action to offer by voice (add a task / remind someone). */
  private async actionOffer(answer: string, question: string): Promise<AskOffer | undefined> {
    const prompt = `Sandy asked: "${question}"\nEmo answered: "${answer.slice(0, 800)}"\n\nIf there is ONE clear, specific next action Sandy would likely want RIGHT NOW — either add a TASK, or send a REMINDER to a named person — reply with JSON:\n{"offer":"<one short spoken yes/no question, e.g. Want me to remind Srikar about the Zigbee testing?>","action":"<a plain command Emo can run, e.g. Remind Srikar to test the Zigbee dongle>"}\nOnly when it's genuinely useful and unambiguous. Otherwise reply exactly: {}`;
    const raw = (await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, prompt, 120, 'emo-ask-offer').catch(() => '')) || '';
    try {
      const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
      const spoken = String(j.offer || '').trim();
      const action = String(j.action || '').trim();
      if (spoken && action) return { spoken, action };
    } catch { /* no offer */ }
    return undefined;
  }

  /** One short spoken sentence — the voice speaks this, not the card. */
  private async summarize(answer: string): Promise<string> {
    const prompt = `You are Emo, speaking to Sandy. In ONE short spoken sentence (max 20 words), give him the key point of this answer to hear. You may use his name occasionally where it flows naturally — do NOT force it or tack it on. No preamble, no "here's", no lists — just the takeaway.\n\n${answer.slice(0, 1500)}`;
    const out = ((await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, prompt, 60, 'emo-ask-summary').catch(() => '')) || '').trim();
    return (out || answer.replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').slice(0, 140)).replace(/^["']|["']$/g, '');
  }
}
