import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService, MemHit } from '../memory/memory.service';
import { LlmService } from '../llm/llm.service';

export const SCOPES = ['everything', 'bookmark', 'idea', 'activity', 'document', 'skill'] as const;
export type Scope = (typeof SCOPES)[number];

/** Map a chat scope to the SuperMemory tags to filter by ([] = whole brain). */
function scopeTags(scope: string): string[] {
  switch (scope) {
    case 'bookmark':
      return ['bookmark'];
    case 'idea':
      return ['idea'];
    case 'activity':
      return ['activity'];
    case 'skill':
      return ['skill'];
    default:
      return []; // everything + document → no tag filter (document refined later)
  }
}

type Source = { title: string; url?: string; itemId?: string };

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
  ) {}

  onModuleInit() {
    // Hourly: clean up threads past the retention window (starred copies are preserved separately).
    this.tick = setInterval(() => this.retentionTick().catch(() => undefined), 60 * 60 * 1000);
  }
  onModuleDestroy() {
    if (this.tick) clearInterval(this.tick);
  }

  // ---- sessions ----
  async createSession(scope?: string) {
    const s = SCOPES.includes(scope as Scope) ? (scope as Scope) : 'everything';
    const row = await this.prisma.chatSession.create({ data: { scope: s } });
    return this.shapeSession(row, []);
  }

  async listSessions() {
    const rows = await this.prisma.chatSession.findMany({ orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }, { createdAt: 'desc' }], take: 500 });
    return rows.map((r) => this.shapeSession(r, []));
  }

  async getSession(id: string) {
    const s = await this.prisma.chatSession.findUnique({ where: { id } });
    if (!s) return null;
    const msgs = await this.prisma.chatMessage.findMany({ where: { sessionId: id }, orderBy: { createdAt: 'asc' } });
    return this.shapeSession(s, msgs);
  }

  async deleteSession(id: string) {
    await this.prisma.chatMessage.deleteMany({ where: { sessionId: id } });
    await this.prisma.chatSession.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  private shapeSession(s: any, msgs: any[]) {
    return {
      id: s.id,
      title: s.title || 'New chat',
      scope: s.scope,
      pinned: s.pinned,
      lastMessageAt: s.lastMessageAt,
      createdAt: s.createdAt,
      messages: msgs.map((m) => this.shapeMessage(m)),
    };
  }
  private shapeMessage(m: any) {
    const j = (v: string | null) => { try { return v ? JSON.parse(v) : []; } catch { return []; } };
    return { id: m.id, role: m.role, content: m.content, sources: j(m.sources), followups: j(m.followups), starred: m.starred, createdAt: m.createdAt };
  }

  // ---- the engine ----
  async sendMessage(sessionId: string, text: string) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session) return null;
    const clean = (text || '').trim();
    if (!clean) return null;

    const recentRows = await this.prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 8 });
    const recent = recentRows.reverse();

    const userMsg = await this.prisma.chatMessage.create({ data: { sessionId, role: 'user', content: clean } });

    // 1) router/rewrite — decide whether to search and craft a standalone query
    const route = await this.route(session, recent, clean);

    // 2) scoped retrieval (only when needed)
    let hits: MemHit[] = [];
    if (route.search) hits = await this.memory.searchScoped(route.query || clean, scopeTags(session.scope), 5);

    // 3) build clickable citations (reverse-lookup our Item by memory id)
    const sources = await this.toSources(hits);

    // 4) grounded answer + suggested follow-ups
    const { answer, followups } = await this.answer(session, recent, clean, hits, route.search);

    const aMsg = await this.prisma.chatMessage.create({
      data: { sessionId, role: 'assistant', content: answer, sources: JSON.stringify(sources), followups: JSON.stringify(followups) },
    });

    // 5) housekeeping: auto-title from first message, bump lastMessageAt
    const data: any = { lastMessageAt: new Date() };
    if (!session.title) data.title = clean.slice(0, 60);
    await this.prisma.chatSession.update({ where: { id: sessionId }, data });

    return { userMessage: this.shapeMessage(userMsg), message: this.shapeMessage(aMsg) };
  }

  private async route(session: any, recent: any[], text: string): Promise<{ search: boolean; query: string }> {
    if (recent.length === 0) return { search: true, query: text }; // first question → always search
    const convo = recent.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-2000);
    const prompt =
      `You route a "chat with my memory" assistant. Decide if the NEW message needs a fresh search of the user's saved memory (a new topic or specific recall) ` +
      `or can be answered from the conversation already shown (a follow-up, clarification, "explain", or counter-question).\n` +
      (session.summary ? `Earlier summary: ${session.summary}\n` : '') +
      `Conversation:\n${convo}\n\nNew message: ${text}\n\n` +
      `Respond with ONLY JSON: {"search": true|false, "query": "<a standalone search query if search is true, else empty>"}`;
    const out = await this.llm.complete(prompt, 150);
    try {
      const j = JSON.parse(out!.slice(out!.indexOf('{'), out!.lastIndexOf('}') + 1));
      return { search: !!j.search, query: String(j.query || text) };
    } catch {
      return { search: true, query: text }; // safe default: search
    }
  }

  private buildAnswerPrompt(session: any, recent: any[], text: string, hits: MemHit[], didSearch: boolean): string {
    const convo = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n').slice(-3000);
    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title || 'Saved item'}\n${h.content}`).join('\n\n');
    const sys =
      `You are the user's personal "second brain" assistant. You answer using (a) this conversation and (b) the MEMORY EXCERPTS below — passages from the user's OWN saved bookmarks, notes, ideas, documents and activity that have ALREADY been retrieved for you.\n\n` +
      `Hard rules:\n` +
      `- The excerpts ARE available to you. NEVER say you can't access, browse, fetch or open anything. NEVER mention URLs, links, Caddy, servers, subdomains, proxies, or your own limitations.\n` +
      `- Answer the user's question DIRECTLY and helpfully in clean Markdown (short paragraphs, **bold**, bullet lists). Synthesize across excerpts; don't just quote fragments.\n` +
      (hits.length ? `- Cite the excerpts you actually use inline as [1], [2].\n` : '') +
      `- If the user pasted a link, the matching excerpt IS that page's saved content — answer from it.\n` +
      `- If the excerpts genuinely don't contain the answer, say briefly: "I don't have anything saved about that in your ${session.scope === 'everything' ? 'memory' : session.scope + 's'}." Then stop — no tangents, no infrastructure talk.\n` +
      `- Never invent facts that aren't in the excerpts or conversation.`;
    return (
      `${sys}\n\n` +
      (session.summary ? `Earlier summary of this chat: ${session.summary}\n\n` : '') +
      (convo ? `Conversation so far:\n${convo}\n\n` : '') +
      (hits.length ? `MEMORY EXCERPTS (the user's saved content):\n${ctx}\n\n` : didSearch ? `MEMORY EXCERPTS: (none found)\n\n` : '') +
      `User's message: ${text}\n\n` +
      `Write the answer now. After it, on a new line output exactly "FOLLOWUPS:" then 2-3 short natural follow-up questions the user might ask next, separated by " | ".`
    );
  }

  private splitAnswer(raw: string): { answer: string; followups: string[] } {
    const text = raw || "I couldn't generate a reply just now — try again.";
    const idx = text.indexOf('FOLLOWUPS:');
    if (idx < 0) return { answer: text.trim(), followups: [] };
    return {
      answer: text.slice(0, idx).trim(),
      followups: text.slice(idx + 'FOLLOWUPS:'.length).split('|').map((s) => s.replace(/^[-•\s]+/, '').trim()).filter(Boolean).slice(0, 3),
    };
  }

  private async answer(session: any, recent: any[], text: string, hits: MemHit[], didSearch: boolean): Promise<{ answer: string; followups: string[] }> {
    const raw = (await this.llm.complete(this.buildAnswerPrompt(session, recent, text, hits, didSearch), 800)) || '';
    return this.splitAnswer(raw);
  }

  /** Like sendMessage but streams answer tokens via onToken; saves + returns the final messages. */
  async streamMessage(sessionId: string, text: string, onToken: (t: string) => void) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session) return null;
    const clean = (text || '').trim();
    if (!clean) return null;

    const recentRows = await this.prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 8 });
    const recent = recentRows.reverse();
    const userMsg = await this.prisma.chatMessage.create({ data: { sessionId, role: 'user', content: clean } });

    const route = await this.route(session, recent, clean);
    let hits: MemHit[] = [];
    if (route.search) hits = await this.memory.searchScoped(route.query || clean, scopeTags(session.scope), 5);
    const sources = await this.toSources(hits);

    const prompt = this.buildAnswerPrompt(session, recent, clean, hits, route.search);
    const cfg = await this.llm.getConfig();
    const full = (await this.llm.completeStream(cfg, prompt, 800, onToken)) || '';
    const { answer, followups } = this.splitAnswer(full);

    const aMsg = await this.prisma.chatMessage.create({
      data: { sessionId, role: 'assistant', content: answer, sources: JSON.stringify(sources), followups: JSON.stringify(followups) },
    });
    const data: any = { lastMessageAt: new Date() };
    if (!session.title) data.title = clean.slice(0, 60);
    await this.prisma.chatSession.update({ where: { id: sessionId }, data });

    return { userMessage: this.shapeMessage(userMsg), message: this.shapeMessage(aMsg) };
  }

  /** Map memory hits to clickable sources (link to our internal Item when we can match it). */
  private async toSources(hits: MemHit[]): Promise<Source[]> {
    const out: Source[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      let itemId: string | undefined;
      let title = h.title;
      let url = h.url;
      if (h.memId) {
        const it = await this.prisma.item.findFirst({ where: { OR: [{ supermemoryId: h.memId }, { ragId: h.memId }] }, select: { id: true, title: true, sourceUrl: true } });
        if (it) {
          itemId = it.id;
          title = title || it.title || 'Saved item';
          url = url || it.sourceUrl || undefined;
        }
      }
      const key = itemId || url || title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ title: title || 'Memory', url, itemId });
    }
    return out;
  }

  // ---- threads: pin + search ----
  async setPinned(id: string, pinned: boolean) {
    await this.prisma.chatSession.update({ where: { id }, data: { pinned: !!pinned } }).catch(() => null);
    return { ok: true, pinned: !!pinned };
  }

  async searchSessions(q: string) {
    const s = (q || '').trim();
    if (!s) return this.listSessions();
    const rows = await this.prisma.chatSession.findMany({ orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }, { createdAt: 'desc' }], take: 500 });
    const hitMsgs = await this.prisma.chatMessage.findMany({ where: { content: { contains: s } }, select: { sessionId: true } });
    const ids = new Set(hitMsgs.map((m) => m.sessionId));
    const low = s.toLowerCase();
    return rows.filter((r) => (r.title || '').toLowerCase().includes(low) || ids.has(r.id)).map((r) => this.shapeSession(r, []));
  }

  // ---- star (preserved copy survives retention) ----
  async setStar(messageId: string, on: boolean) {
    const m = await this.prisma.chatMessage.findUnique({ where: { id: messageId } });
    if (!m) return null;
    await this.prisma.chatMessage.update({ where: { id: messageId }, data: { starred: !!on } });
    if (on) {
      const session = await this.prisma.chatSession.findUnique({ where: { id: m.sessionId } });
      await this.prisma.chatStar.upsert({
        where: { messageId },
        create: { messageId, sessionId: m.sessionId, sessionTitle: session?.title || 'Chat', scope: session?.scope || 'everything', role: m.role, content: m.content, sources: m.sources },
        update: {},
      });
    } else {
      await this.prisma.chatStar.deleteMany({ where: { messageId } });
    }
    return { starred: !!on };
  }

  async listStarred() {
    const rows = await this.prisma.chatStar.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
    const j = (v: string | null) => { try { return v ? JSON.parse(v) : []; } catch { return []; } };
    return rows.map((r) => ({ id: r.id, messageId: r.messageId, sessionId: r.sessionId, sessionTitle: r.sessionTitle, scope: r.scope, role: r.role, content: r.content, sources: j(r.sources), createdAt: r.createdAt }));
  }

  // ---- retention ----
  async getRetention() {
    const row = await this.prisma.setting.findUnique({ where: { key: 'chat.retentionMonths' } });
    return { months: row ? Number(row.value) || 2 : 2 }; // 0 = keep forever
  }
  async setRetention(months: number) {
    const v = Math.max(0, Math.min(24, Math.round(Number(months) || 0)));
    await this.prisma.setting.upsert({ where: { key: 'chat.retentionMonths' }, create: { key: 'chat.retentionMonths', value: String(v) }, update: { value: String(v) } });
    return { months: v };
  }

  async retentionTick() {
    const { months } = await this.getRetention();
    if (!months) return; // forever
    const cutoff = new Date(Date.now() - months * 30 * 24 * 60 * 60 * 1000);
    const old = await this.prisma.chatSession.findMany({ where: { pinned: false }, select: { id: true, lastMessageAt: true, createdAt: true } });
    for (const s of old) {
      const when = s.lastMessageAt || s.createdAt;
      if (when && new Date(when) < cutoff) {
        await this.prisma.chatMessage.deleteMany({ where: { sessionId: s.id } });
        await this.prisma.chatSession.delete({ where: { id: s.id } }).catch(() => null);
        // ChatStar rows are NOT touched — starred messages are kept forever.
      }
    }
  }
}
