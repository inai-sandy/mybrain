import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { ExploreService } from '../explore/explore.service';
import { EmoCardsService } from './emo-cards.service';

export type AskTurn = { role: 'user' | 'emo'; text: string };
export type AskOffer = { spoken: string; action: string };
export type AskResult = { mode: 'clarify'; question: string } | { mode: 'answer'; summary: string; cardId: string; offer?: AskOffer };

/**
 * EMO Ask (BEA-890) — the interactive voice Ask. One HTTP call per turn:
 * always asks at least ONE relevant clarifying question first (grounded in what's actually in the
 * brain), a 2nd/3rd only if still broad (cap 3), then answers from the whole brain, FILES a Search
 * card (the receipt — full answer + detail), and returns a SHORT spoken summary. The voice speaks
 * the summary only; it never reads the card.
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

    // Thread memory: what Sandy already asked earlier this session (to resolve "that" / "the other one").
    const sessionCtx = (input.sessionContext || '').trim();
    const ctxBlock = sessionCtx ? `\n\nEarlier this session (use to resolve references like "that", "the other one"):\n${sessionCtx}\n` : '';

    const clarifyCount = history.filter((t) => t.role === 'emo').length;
    const convo = [...history, { role: 'user' as const, text: userText }].map((t) => `${t.role === 'emo' ? 'Emo' : 'User'}: ${t.text}`).join('\n');

    // Ground the clarifying question in what's ACTUALLY in the brain (so it's relevant, not generic).
    const hits = await this.memory.searchBrain(`${sessionCtx} ${convo}`.slice(0, 400), 8).catch(() => [] as any[]);
    const topics = hits.length
      ? hits.map((h: any, i: number) => `${i + 1}. ${h.title || 'untitled'} — ${(h.content || '').replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')
      : '(nothing found yet)';

    // Always clarify at least once; after that only if still broad; hard cap at 3.
    // `direct` (the EMO device) skips clarifying entirely — answer on the best guess.
    if (clarifyCount < 3 && !input.direct) {
      const q = await this.decideClarify(convo + ctxBlock, topics, clarifyCount === 0);
      if (q) return { mode: 'clarify', question: q };
    }

    // Answer from the whole brain, then file the Search card.
    const userTurns = [...history.filter((t) => t.role === 'user').map((t) => t.text), userText].filter(Boolean);
    const baseQ = userTurns.length > 1 ? `${userTurns[0]} — specifically: ${userTurns.slice(1).join('; ')}` : userTurns[0] || userText;
    const retrievalQ = sessionCtx ? `${baseQ}\n\n(Earlier context: ${sessionCtx})` : baseQ;
    const ans = await this.explore.ask(retrievalQ, { web: input.web || 'auto', withSummary: true, ragOnly: input.ragOnly }).catch(() => ({ answer: '', sources: [] as any[], matches: 0, usedWeb: false, summary: undefined as string | undefined }));
    const answer = (ans.answer || '').trim() || "I couldn't find anything about that in your brain yet.";
    // one call already gave us the spoken summary; fall back to the first sentence (no extra model call).
    const summary = ((ans as any).summary || '').trim() || (answer.split(/(?<=[.!?])\s/)[0] || answer).slice(0, 200);
    // A COMPLETE card: the question + the full answer (inline [n] citations become tappable chips),
    // with the cited sources stored STRUCTURED on the card so app + web render them as accordions.
    const sources = (ans.sources || []) as any[];
    const detail = `**${baseQ}**\n\n${answer}`;
    const card = await this.cards.create({ lane: 'search', status: 'done', summary, detail, rawTranscript: baseQ, sources });
    const offer = await this.actionOffer(answer, baseQ).catch(() => undefined);
    return { mode: 'answer', summary, cardId: (card as any).id, offer };
  }

  /** Decide whether to ask another clarifying question. Returns the question, or '' to answer now. */
  private async decideClarify(convo: string, topics: string, force: boolean): Promise<string> {
    const instr = force
      ? `Ask ONE short, specific clarifying question that narrows this down — pick the single most useful filter (which topic / which person / what timeframe / done-or-pending), grounded in the topics found. Under 14 words. Output ONLY the question.`
      : `You have ALREADY asked a clarifying question and the user answered. STRONGLY prefer to answer now: output exactly ANSWER — unless you genuinely still cannot tell what to search for, in which case ask ONE final short question (under 14 words). Default to ANSWER.`;
    const prompt = `You are Emo, Sandy's warm personal voice assistant, narrowing a question before you answer from his brain. Ask only about what would change the answer. Use his name (Sandy) only occasionally, where it flows naturally — usually leave it out; never tack it on.\n\nConversation:\n${convo}\n\nTopics found in his brain:\n${topics}\n\n${instr}`;
    const out = ((await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, prompt, 60, 'emo-ask-clarify').catch(() => '')) || '').trim();
    if (!out || /^answer\b/i.test(out)) return '';
    return out.replace(/^(emo|question)\s*:\s*/i, '').replace(/^["']|["']$/g, '').slice(0, 160);
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
