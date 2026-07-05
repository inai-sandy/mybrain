import { Injectable, Logger } from '@nestjs/common';
import { LlmService } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { ExploreService } from '../explore/explore.service';
import { EmoCardsService } from './emo-cards.service';

export type AskTurn = { role: 'user' | 'emo'; text: string };
export type AskResult = { mode: 'clarify'; question: string } | { mode: 'answer'; summary: string; cardId: string };

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

  async ask(input: { question: string; history?: AskTurn[] }): Promise<AskResult> {
    const history = (input.history || []).filter((t) => t && t.text && (t.role === 'user' || t.role === 'emo'));
    const userText = (input.question || '').trim();
    if (!userText && !history.length) return { mode: 'clarify', question: 'What would you like to know?' };

    const clarifyCount = history.filter((t) => t.role === 'emo').length;
    const convo = [...history, { role: 'user' as const, text: userText }].map((t) => `${t.role === 'emo' ? 'Emo' : 'User'}: ${t.text}`).join('\n');

    // Ground the clarifying question in what's ACTUALLY in the brain (so it's relevant, not generic).
    const hits = await this.memory.searchBrain(convo.slice(0, 400), 8).catch(() => [] as any[]);
    const topics = hits.length
      ? hits.map((h: any, i: number) => `${i + 1}. ${h.title || 'untitled'} — ${(h.content || '').replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')
      : '(nothing found yet)';

    // Always clarify at least once; after that only if still broad; hard cap at 3.
    if (clarifyCount < 3) {
      const q = await this.decideClarify(convo, topics, clarifyCount === 0);
      if (q) return { mode: 'clarify', question: q };
    }

    // Answer from the whole brain, then file the Search card.
    const userTurns = [...history.filter((t) => t.role === 'user').map((t) => t.text), userText].filter(Boolean);
    const refined = userTurns.length > 1 ? `${userTurns[0]} — specifically: ${userTurns.slice(1).join('; ')}` : userTurns[0] || userText;
    const ans = await this.explore.ask(refined).catch(() => ({ answer: '', sources: [] as any[], matches: 0 }));
    const answer = (ans.answer || '').trim() || "I couldn't find anything about that in your brain yet.";
    const summary = await this.summarize(answer);
    // A COMPLETE card: the question, the full answer, and cited sources (renders scrollable in the detail view).
    const sources = (ans.sources || []) as any[];
    const sourcesMd = sources.length
      ? '\n\n---\n\n**Sources**\n\n' + sources.map((s) => `${s.n ?? '•'}. ${s.link ? `[${s.title || 'Source'}](${s.link})` : s.title || 'Source'}${s.when ? ` · ${s.when}` : ''}${s.snippet ? `\n   ${String(s.snippet).replace(/\s+/g, ' ').slice(0, 160)}` : ''}`).join('\n')
      : '';
    const detail = `**${refined}**\n\n${answer}${sourcesMd}`;
    const card = await this.cards.create({ lane: 'search', status: 'done', summary, detail, rawTranscript: refined });
    return { mode: 'answer', summary, cardId: (card as any).id };
  }

  /** Decide whether to ask another clarifying question. Returns the question, or '' to answer now. */
  private async decideClarify(convo: string, topics: string, force: boolean): Promise<string> {
    const instr = force
      ? `Ask ONE short, specific clarifying question that narrows this down — pick the single most useful filter (which topic / which person / what timeframe / done-or-pending), grounded in the topics found. Under 14 words. Output ONLY the question.`
      : `You have ALREADY asked a clarifying question and the user answered. STRONGLY prefer to answer now: output exactly ANSWER — unless you genuinely still cannot tell what to search for, in which case ask ONE final short question (under 14 words). Default to ANSWER.`;
    const prompt = `You are Emo, Sandy's warm personal voice assistant, narrowing a question before you answer from his brain. Ask only about what would change the answer. Address him by name (Sandy) naturally — not in every line.\n\nConversation:\n${convo}\n\nTopics found in his brain:\n${topics}\n\n${instr}`;
    const out = ((await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, prompt, 60, 'emo-ask-clarify').catch(() => '')) || '').trim();
    if (!out || /^answer\b/i.test(out)) return '';
    return out.replace(/^(emo|question)\s*:\s*/i, '').replace(/^["']|["']$/g, '').slice(0, 160);
  }

  /** One short spoken sentence — the voice speaks this, not the card. */
  private async summarize(answer: string): Promise<string> {
    const prompt = `You are Emo, speaking to Sandy. In ONE short spoken sentence (max 20 words), give him the key point of this answer to hear. Address him by name (Sandy). No preamble, no "here's", no lists — just the takeaway.\n\n${answer.slice(0, 1500)}`;
    const out = ((await this.llm.completeWith({ provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }, prompt, 60, 'emo-ask-summary').catch(() => '')) || '').trim();
    return (out || answer.replace(/[#*_`>[\]]/g, '').replace(/\s+/g, ' ').slice(0, 140)).replace(/^["']|["']$/g, '');
  }
}
