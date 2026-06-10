import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { promises as fs } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService, MemHit } from '../memory/memory.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';

const DEFAULT_CHAT_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' };

export const SCOPES = ['everything', 'bookmark', 'idea', 'activity', 'document', 'skill'] as const;
export type Scope = (typeof SCOPES)[number];

const SPECIAL_TAGS = ['bookmark', 'idea', 'activity', 'skill'];

/** A chat scope → which tags must be present (include) / absent (exclude). Empty/empty = whole brain. */
function scopeFilter(scope: string): { include: string[]; exclude: string[] } {
  switch (scope) {
    case 'bookmark':
      return { include: ['bookmark'], exclude: [] };
    case 'idea':
      return { include: ['idea'], exclude: [] };
    case 'activity':
      return { include: ['activity'], exclude: [] };
    case 'skill':
      return { include: ['skill'], exclude: [] };
    case 'document':
      // Capture = your documents: everything that ISN'T one of the special buckets.
      return { include: [], exclude: SPECIAL_TAGS };
    default:
      return { include: [], exclude: [] }; // everything
  }
}

const SCOPE_LABEL: Record<string, string> = {
  bookmark: 'Bookmarks',
  idea: 'Ideas',
  activity: 'Activity',
  skill: 'Skills',
  document: 'Capture',
  everything: 'brain',
};
function scopeLabel(scope: string): string {
  return SCOPE_LABEL[scope] || 'brain';
}

type Source = { title: string; url?: string; itemId?: string };

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
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
    const rows = await this.prisma.chatSession.findMany({ where: { docId: null }, orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }, { createdAt: 'desc' }], take: 500 });
    return rows.map((r) => this.shapeSession(r, []));
  }

  /** Get (or create) the chat thread bound to a single document. */
  async docSession(itemId: string) {
    const item = await this.prisma.item.findUnique({ where: { id: itemId } });
    if (!item) return null;
    let s = await this.prisma.chatSession.findFirst({ where: { docId: itemId } });
    if (!s) s = await this.prisma.chatSession.create({ data: { scope: 'document', docId: itemId, title: item.title || 'Document' } });
    const msgs = await this.prisma.chatMessage.findMany({ where: { sessionId: s.id }, orderBy: { createdAt: 'asc' } });
    return { ...this.shapeSession(s, msgs), docTitle: item.title || 'Document' };
  }

  /** The bound document's content, as a single context "excerpt". */
  private async docHits(docId: string): Promise<MemHit[]> {
    const it = await this.prisma.item.findUnique({ where: { id: docId } });
    if (!it) return [];
    let content = it.summary || '';
    if (it.filePath) {
      try {
        content = await fs.readFile(it.filePath, 'utf8');
      } catch {
        /* fall back to summary */
      }
    }
    return content.trim() ? [{ title: it.title || 'Document', content: content.slice(0, 12000), source: 'rag' }] : [];
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

    // retrieval: a bound document, or scoped memory (router decides when to search)
    let hits: MemHit[] = [];
    let sources: Source[] = [];
    let didSearch = true;
    if (session.docId) {
      hits = await this.docHits(session.docId);
      sources = hits.length ? [{ title: session.title || 'Document', itemId: session.docId }] : [];
    } else {
      const route = await this.route(session, recent, clean);
      didSearch = route.search;
      if (route.search) {
        const f = scopeFilter(session.scope);
        hits = await this.memory.searchScoped(route.query || clean, f.include, 5, f.exclude);
      }
      sources = await this.toSources(hits);
    }

    // grounded answer + suggested follow-ups
    const { answer, followups } = await this.answer(session, recent, clean, hits, didSearch);

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
    const tmpl = await this.prompts.get('chat.router');
    const prompt = `${tmpl}\n\n` + (session.summary ? `Earlier summary: ${session.summary}\n` : '') + `Conversation:\n${convo}\n\nNew message: ${text}`;
    const out = await this.llm.completeWith(await this.getModel(), prompt, 150, 'chat-router');
    try {
      const j = JSON.parse(out!.slice(out!.indexOf('{'), out!.lastIndexOf('}') + 1));
      return { search: !!j.search, query: String(j.query || text) };
    } catch {
      return { search: true, query: text }; // safe default: search
    }
  }

  /** Find matching items across the whole brain (for the search bar). Returns clickable results. */
  async findItems(q: string): Promise<{ title: string; snippet: string; type: string; itemId?: string; url?: string }[]> {
    const clean = (q || '').trim();
    if (!clean) return [];
    const hits = await this.memory.searchScoped(clean, [], 8);
    const out: { title: string; snippet: string; type: string; itemId?: string; url?: string }[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
      let itemId: string | undefined;
      let title = h.title;
      let url = h.url;
      let type = 'memory';
      if (h.memId) {
        const it = await this.prisma.item.findFirst({ where: { OR: [{ supermemoryId: h.memId }, { ragId: h.memId }] }, select: { id: true, title: true, sourceUrl: true, source: true } });
        if (it) {
          itemId = it.id;
          title = title || it.title || undefined;
          url = url || it.sourceUrl || undefined;
          type = it.source === 'raindrop' ? 'bookmark' : 'document';
        }
      }
      const key = itemId || url || title || '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ title: title || 'Saved item', snippet: (h.content || '').replace(/\s+/g, ' ').trim().slice(0, 160), type, itemId, url });
    }
    return out;
  }

  /** Stateless one-shot Q&A over memory (for Telegram /ask). No thread is saved. */
  async askOnce(question: string, scope = 'everything'): Promise<{ answer: string; sources: Source[] }> {
    const clean = (question || '').trim();
    if (!clean) return { answer: '', sources: [] };
    const f = scopeFilter(scope);
    const hits = await this.memory.searchScoped(clean, f.include, 5, f.exclude);
    // Strict scope: when a specific subject is chosen and nothing matches, say so — never widen.
    if (!hits.length && scope !== 'everything') {
      return { answer: `I don't have anything in your **${scopeLabel(scope)}** about that.`, sources: [] };
    }
    const sources = await this.toSources(hits);
    const prompt = await this.buildAnswerPrompt({ scope, summary: null }, [], clean, hits, true);
    const raw = (await this.llm.completeWith(await this.getModel(), prompt, 800, 'chat')) || '';
    return { answer: this.splitAnswer(raw).answer, sources };
  }

  private async buildAnswerPrompt(session: any, recent: any[], text: string, hits: MemHit[], didSearch: boolean): Promise<string> {
    const convo = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n').slice(-3000);

    // Per-document chat: the single excerpt IS the document the user is asking about.
    if (session.docId) {
      return (
        `You are answering questions about ONE specific document for the user. The FULL document is provided below. ` +
        `Answer only from this document, in clean Markdown (short paragraphs, **bold**, bullet lists). Be direct and helpful. ` +
        `If the document doesn't cover the question, say so briefly. NEVER claim you don't have a document — it is right here.\n\n` +
        (convo ? `Conversation so far:\n${convo}\n\n` : '') +
        `DOCUMENT — "${hits[0]?.title || 'Document'}":\n${hits.map((h) => h.content).join('\n\n') || '(this document is empty)'}\n\n` +
        `User's question: ${text}\n\n` +
        `After your answer, on a new line output exactly "FOLLOWUPS:" then 2-3 short follow-up questions about this document, separated by " | ".`
      );
    }

    const ctx = hits.map((h, i) => `[${i + 1}] ${h.title || 'Saved item'}\n${h.content}`).join('\n\n');
    const sys = await this.prompts.get('chat.answer');
    const scoped = session.scope && session.scope !== 'everything';
    const scopeNote = scoped
      ? `The user is asking ONLY within their "${scopeLabel(session.scope)}". Use ONLY the excerpts below; if they don't answer it, reply exactly that you don't have anything in their ${scopeLabel(session.scope)} about that — do NOT pull from anywhere else.\n\n`
      : '';
    return (
      `${sys}\n\n` +
      scopeNote +
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
    const raw = (await this.llm.completeWith(await this.getModel(), await this.buildAnswerPrompt(session, recent, text, hits, didSearch), 800, 'chat')) || '';
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

    let hits: MemHit[] = [];
    let sources: Source[] = [];
    let didSearch = true;
    if (session.docId) {
      hits = await this.docHits(session.docId);
      sources = hits.length ? [{ title: session.title || 'Document', itemId: session.docId }] : [];
    } else {
      const route = await this.route(session, recent, clean);
      didSearch = route.search;
      if (route.search) {
        const f = scopeFilter(session.scope);
        hits = await this.memory.searchScoped(route.query || clean, f.include, 5, f.exclude);
      }
      sources = await this.toSources(hits);
    }

    const prompt = await this.buildAnswerPrompt(session, recent, clean, hits, didSearch);
    const cfg = await this.getModel();
    const full = (await this.llm.completeStream(cfg, prompt, 800, onToken, 'chat')) || '';
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
    const rows = await this.prisma.chatSession.findMany({ where: { docId: null }, orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }, { createdAt: 'desc' }], take: 500 });
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

  // ---- chat model (its own, fast by default — the app default can be slow) ----
  async getModel(): Promise<LlmConfig> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'chat.llm' } });
    if (!row) return DEFAULT_CHAT_MODEL;
    try {
      const v = JSON.parse(row.value);
      return v?.provider && v?.model ? v : DEFAULT_CHAT_MODEL;
    } catch {
      return DEFAULT_CHAT_MODEL;
    }
  }
  async setModel(provider: string, model: string): Promise<LlmConfig> {
    const value = JSON.stringify({ provider: provider || 'openrouter', model });
    await this.prisma.setting.upsert({ where: { key: 'chat.llm' }, create: { key: 'chat.llm', value }, update: { value } });
    return { provider: provider || 'openrouter', model } as LlmConfig;
  }
  async listModels() {
    return this.llm.listOpenRouterModels(['openai/', 'anthropic/', 'google/']);
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
