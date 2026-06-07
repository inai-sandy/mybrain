import { Injectable } from '@nestjs/common';
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
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
  ) {}

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

  private async answer(session: any, recent: any[], text: string, hits: MemHit[], didSearch: boolean): Promise<{ answer: string; followups: string[] }> {
    const convo = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n').slice(-3000);
    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title ? h.title + ': ' : ''}${h.content}`).join('\n\n');
    const sys =
      `You are the user's "second brain" — answer from their saved memory and this conversation only. Be concise and direct. ` +
      (hits.length ? `Cite the snippets you use inline as [1], [2]. ` : '') +
      (didSearch && !hits.length ? `Nothing relevant was found in their memory for this — tell them you don't have anything saved about that; do NOT invent facts. ` : '') +
      `Never fabricate.`;
    const prompt =
      `${sys}\n\n` +
      (session.summary ? `Earlier summary: ${session.summary}\n\n` : '') +
      `Conversation so far:\n${convo || '(none)'}\n\n` +
      (hits.length ? `Memory snippets:\n${ctx}\n\n` : '') +
      `User: ${text}\n\n` +
      `After your answer, on a new line output exactly "FOLLOWUPS:" then 2-3 short follow-up questions the user might ask next, separated by " | ".`;
    const raw = (await this.llm.complete(prompt, 800)) || "I couldn't generate a reply just now — try again.";
    const idx = raw.indexOf('FOLLOWUPS:');
    let answer = raw;
    let followups: string[] = [];
    if (idx >= 0) {
      answer = raw.slice(0, idx).trim();
      followups = raw.slice(idx + 'FOLLOWUPS:'.length).split('|').map((s) => s.replace(/^[-•\s]+/, '').trim()).filter(Boolean).slice(0, 3);
    }
    return { answer: answer.trim(), followups };
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
}
