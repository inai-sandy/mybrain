import { Injectable, Logger } from '@nestjs/common';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { MemoryService } from '../memory/memory.service';
import { ExploreService } from '../explore/explore.service';
import { EmoCardsService } from './emo-cards.service';
import { PrismaService } from '../prisma/prisma.service';

/** Default Talk brain — Haiku (fast + cheap for conversation). Overridable via `emo.talk.model`. */
const DEFAULT_TALK_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };

type Turn = { role: 'user' | 'emo'; text: string };
export type TalkResult = { conversationId: string; reply: string; sources: any[]; usedWeb: boolean };

/**
 * EMO Talk (BEA-905) — a real multi-turn conversation, distinct from Ask. Runs on Haiku (configurable),
 * remembers the thread, optionally reaches the web, and persists the WHOLE conversation as ONE card.
 */
@Injectable()
export class EmoTalkService {
  private readonly log = new Logger('EmoTalk');
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly memory: MemoryService,
    private readonly explore: ExploreService,
    private readonly cards: EmoCardsService,
  ) {}

  private async talkModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'emo.talk.model' } }).catch(() => null);
    if (row) { try { const v = JSON.parse(row.value); if (v?.provider && v?.model) return v; } catch { /* default */ } }
    return DEFAULT_TALK_MODEL;
  }

  async talk(input: { message: string; conversationId?: string; web?: 'on' | 'off' | 'auto' }): Promise<TalkResult> {
    const msg = (input.message || '').trim();
    if (!msg) return { conversationId: input.conversationId || '', reply: '', sources: [], usedWeb: false };

    // Load the existing conversation card (if any) for its running transcript.
    let cardId = input.conversationId || null;
    let turns: Turn[] = [];
    if (cardId) {
      const row = await this.prisma.emoCard.findUnique({ where: { id: cardId } }).catch(() => null);
      if (row?.rawTranscript) { try { const t = JSON.parse(row.rawTranscript); if (Array.isArray(t)) turns = t; } catch { /* fresh */ } }
      if (!row) cardId = null;
    }

    // Ground the reply in his brain + (optionally) the web.
    const brainHits = await this.memory.searchBrain(msg, 6).catch(() => [] as any[]);
    const brainCtx = brainHits.length ? brainHits.map((h: any, i: number) => `[b${i + 1}] ${h.title || ''}: ${String(h.content || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') : '';
    const web = input.web || 'off';
    const wantWeb = web === 'on' || (web === 'auto' && this.explore.needsWeb(msg));
    const webSources = wantWeb ? await this.explore.searchWeb(msg, 4) : [];
    const webCtx = webSources.length ? webSources.map((s) => `[w${s.n}] ${s.title}: ${s.snippet}`).join('\n') : '';

    const convo = turns.slice(-10).map((t) => `${t.role === 'user' ? 'Sandy' : 'Emo'}: ${t.text}`).join('\n');
    const prompt = `You are Emo, Sandy's warm, concise personal voice assistant having a spoken back-and-forth conversation. Reply in 1-3 short, natural sentences — like talking out loud, not writing. Use his name (Sandy) only occasionally, where it flows. Today is ${this.explore.today()} — when he asks about "latest"/"news"/"recent", use the freshest web results below and mention roughly when they're from. ${brainCtx || webCtx ? 'Use the context below (his brain + current web results) when relevant.' : ''}

${brainCtx ? `From his brain:\n${brainCtx}\n\n` : ''}${webCtx ? `From the web:\n${webCtx}\n\n` : ''}Conversation so far:
${convo || '(this is the first message)'}
Sandy: ${msg}

Emo:`;

    const reply = ((await this.llm.completeWith(await this.talkModel(), prompt, 300, 'emo-talk').catch(() => '')) || "Sorry, I didn't catch that — say it again?").trim();

    // Persist the WHOLE conversation as ONE card.
    turns.push({ role: 'user', text: msg }, { role: 'emo', text: reply });
    const title = (turns.find((t) => t.role === 'user')?.text || 'Conversation').slice(0, 60);
    const detail = turns.map((t) => `**${t.role === 'user' ? 'Sandy' : 'Emo'}:** ${t.text}`).join('\n\n');
    const summary = `Talk · ${title}`;
    const raw = JSON.stringify(turns);
    try {
      if (cardId) {
        await this.cards.update(cardId, { summary, detail, rawTranscript: raw });
      } else {
        const card = await this.cards.create({ lane: 'talk', status: 'done', summary, detail, rawTranscript: raw, source: 'emo-talk' });
        cardId = (card as any).id;
      }
    } catch (e: any) {
      this.log.warn(`talk card persist failed: ${e?.message || e}`);
    }

    return { conversationId: cardId || '', reply, sources: webSources, usedWeb: webSources.length > 0 };
  }
}
