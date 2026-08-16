import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TokenBudgetError } from '../llm/token-budget.service';
import { promises as fs } from 'fs';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService, MemHit, deepLinkFor } from '../memory/memory.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { PromptsService } from '../prompts/prompts.service';
import { ChatGateCard, ChatToolChip, ChatToolOutcome, ChatToolsService } from './chat-tools.service';

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
  activity: 'life log (days, stories, moods)',
  skill: 'Skills',
  document: 'Capture',
  everything: 'brain',
};
function scopeLabel(scope: string): string {
  return SCOPE_LABEL[scope] || 'brain';
}

type Source = { title: string; url?: string; itemId?: string; link?: string; sourceType?: string };

@Injectable()
export class ChatService implements OnModuleInit, OnModuleDestroy {
  /**
   * Chat is the busiest surface in the app, and it was reaching the model with no ceiling at all
   * (BEA-1204). Now that a budget stop throws, it must read as a plain sentence here — a raw 500 in
   * the chat window would break the project's own "friendly errors, never a raw crash" rule.
   */
  private budgetText = (e: unknown): string => {
    if (e instanceof TokenBudgetError) return `I have stopped for now — ${e.message}`;
    return '';
  };

  private tick: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly llm: LlmService,
    private readonly prompts: PromptsService,
    // Optional + LAST — spec harnesses build this service with four arguments. With no tools
    // service at all, every path below falls through to exactly the chat that existed before.
    private readonly tools?: ChatToolsService,
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
    const one = (v: string | null) => { try { return v ? JSON.parse(v) : undefined; } catch { return undefined; } };
    // `tools` and `gate` are only ever set on a reply that really used an outside service, so every
    // message written before BEA-1349 — and every message on a server with nothing connected —
    // comes back the same shape it always did.
    //
    // The gate goes out TRIMMED: the browser gets what the card shows and nothing else. The raw
    // arguments stay on the server, where the re-run reads them — a real action can take a token
    // (`create or update a secret`), and the question the owner reads already has anything named
    // like one masked.
    const g = one(m.gate);
    const gate = g ? { actionId: g.actionId, serviceName: g.serviceName, actionName: g.actionName, headline: g.headline, detail: g.detail, options: g.options, decision: g.decision } : undefined;
    return { id: m.id, role: m.role, content: m.content, sources: j(m.sources), followups: j(m.followups), tools: j(m.tools), gate, starred: m.starred, createdAt: m.createdAt };
  }

  // ---- outside services (BEA-1349) ----

  /**
   * The tool phase of a turn: does this message ask for something one of the owner's connected
   * services should DO?
   *
   * `null` on every road but a real one — nothing connected (the usual answer, and the one that
   * costs nothing), nothing worth running, or the tool side itself falling over. Chat then carries
   * on exactly as it did before this issue existed, which is the point: this is the screen he uses
   * every day, and a feature he has not set up may not change it in any way at all.
   */
  private async toolPhase(recent: any[], text: string, sessionId: string, userMsgId: string, onNote?: (n: string) => void): Promise<ChatToolOutcome | null> {
    if (!this.tools?.maybeRun) return null;
    return this.tools
      .maybeRun({
        text,
        recent: (recent || []).map((m) => ({ role: m.role, content: m.content })),
        model: () => this.getModel(),
        runId: sessionId,
        nodeId: userMsgId,
        onNote,
      })
      .catch(() => null);
  }

  /**
   * The reply for a turn that stopped at a gate, or that really tried and really failed.
   *
   * Written WITHOUT a model call on purpose. A gate has nothing to write up yet, and a failure must
   * reach him as the service's own reason — handing "GitHub could not do that: Not Found (404)" to
   * a model to phrase nicely is exactly how a failure turns into a polite apology, or worse, into a
   * success that never happened.
   */
  private async actedReply(session: any, sessionId: string, clean: string, userMsg: any, out: ChatToolOutcome) {
    const content = out.gate
      ? `${out.gate.headline} — this one cannot be undone, so I have not done anything yet.`
      : String(out.failed || 'That could not be done.');
    const aMsg = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content,
        sources: '[]',
        followups: '[]',
        tools: JSON.stringify(out.chips || []),
        gate: out.gate ? JSON.stringify(out.gate) : null,
      },
    });
    await this.touch(session, sessionId, clean);
    return { userMessage: this.shapeMessage(userMsg), message: this.shapeMessage(aMsg) };
  }

  /** Auto-title from the first message, and bump the thread's clock. */
  private async touch(session: any, sessionId: string, clean: string) {
    const data: any = { lastMessageAt: new Date() };
    if (!session.title) data.title = clean.slice(0, 60);
    await this.prisma.chatSession.update({ where: { id: sessionId }, data });
  }

  /**
   * He tapped Run or Cancel on the inline confirm (BEA-1349).
   *
   * The confirm is inline, not durable: he is sitting in front of the thread, so there is no
   * waitpoint and no notification — but the decision itself is the same one an agent run records,
   * written to `ServiceGate`, and a yes re-runs the step with the exact arguments on the card.
   */
  async answerGate(messageId: string, answer: string) {
    const m = await this.prisma.chatMessage.findUnique({ where: { id: messageId } });
    if (!m) return null;
    let gate: ChatGateCard | null = null;
    try { gate = m.gate ? JSON.parse(m.gate) : null; } catch { gate = null; }
    if (!gate) return { error: 'There is nothing waiting on that message.' };
    if (gate.decision) return { error: `You already answered this one — you said ${gate.decision === 'approved' ? 'yes' : 'no'}.` };
    if (gate.claimedAt) return { error: 'That one is already being dealt with.' };
    if (!this.tools?.answerGate) return { error: 'Outside services are not available on this server.' };

    // Claimed BEFORE anything runs, in ONE conditional write.
    //
    // Reading the row, checking it and then writing it back would leave a gap: two taps a moment
    // apart (or a retry after a dropped answer, or a second tab) can both read "not claimed yet"
    // and both go on to run it. This card only ever sits in front of something that cannot be taken
    // back, so the claim is a single UPDATE … WHERE the claim is not already there, and whoever
    // does not win it stops here.
    const claimed = await this.prisma.chatMessage.updateMany({
      where: { id: messageId, NOT: { gate: { contains: '"claimedAt"' } } },
      data: { gate: JSON.stringify({ ...gate, claimedAt: new Date().toISOString() }) },
    });
    if (!claimed?.count) return { error: 'That one is already being dealt with.' };

    const said = await this.tools.answerGate(gate, answer);
    const decided: ChatGateCard = { ...gate, decision: said.approved ? 'approved' : 'rejected', claimedAt: new Date().toISOString() };
    const out = said.outcome;
    // A no says so and nothing ran. A yes reports what really came back — including a failure, in
    // the service's own words.
    const content = !said.approved ? said.message : out?.failed ? String(out.failed) : `Done — ${gate.headline}.`;
    const chips: ChatToolChip[] = out?.chips || [];

    const row = await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { content, tools: JSON.stringify(chips), gate: JSON.stringify(decided) },
    });
    return { message: this.shapeMessage(row) };
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

    // Outside services first: a gate must stop the turn before anything else is spent on it.
    const acted = await this.toolPhase(recent, clean, sessionId, userMsg.id);
    if (acted?.gate || acted?.failed) return this.actedReply(session, sessionId, clean, userMsg, acted);

    // retrieval: a bound document, or scoped memory (router decides when to search)
    let hits: MemHit[] = [];
    let sources: Source[] = [];
    let didSearch = true;
    if (session.docId) {
      hits = await this.docHits(session.docId);
      sources = hits.length ? [{ title: session.title || 'Document', itemId: session.docId }] : [];
    } else if (!acted?.note) {
      // Skipped when a service just answered this turn: "here are your repositories" is not a
      // question about his saved notes, and four unrelated source chips under it are noise.
      const route = await this.route(session, recent, clean);
      didSearch = route.search;
      if (route.search) {
        const f = scopeFilter(session.scope);
        hits = await this.memory.searchScoped(route.query || clean, f.include, 5, f.exclude);
      }
      sources = await this.toSources(hits);
    } else {
      didSearch = false;
    }

    // grounded answer + suggested follow-ups
    const { answer, followups } = await this.answer(session, recent, clean, hits, didSearch, acted?.note);

    const aMsg = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: answer,
        sources: JSON.stringify(sources),
        followups: JSON.stringify(followups),
        tools: acted?.chips?.length ? JSON.stringify(acted.chips) : null,
      },
    });

    // 5) housekeeping: auto-title from first message, bump lastMessageAt
    await this.touch(session, sessionId, clean);

    return { userMessage: this.shapeMessage(userMsg), message: this.shapeMessage(aMsg) };
  }

  private async route(session: any, recent: any[], text: string): Promise<{ search: boolean; query: string }> {
    if (recent.length === 0) return { search: true, query: text }; // first question → always search
    const convo = recent.map((m) => `${m.role}: ${m.content}`).join('\n').slice(-2000);
    const tmpl = await this.prompts.get('chat.router');
    const prompt = `${tmpl}\n\n` + (session.summary ? `Earlier summary: ${session.summary}\n` : '') + `Conversation:\n${convo}\n\nNew message: ${text}`;
    const out = await this.llm.completeWith(await this.getModel(), prompt, 150, 'chat-router').catch(() => null);
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
    const raw = (await this.llm.completeWith(await this.getModel(), prompt, 800, 'chat').catch(this.budgetText)) || '';
    return { answer: this.splitAnswer(raw).answer, sources };
  }

  /**
   * What an outside service just did, as fact for the reply to be written from (BEA-1349).
   *
   * It is stated as something that HAS happened, and the model is told to report it rather than
   * decide about it — the deciding and the doing are already over by the time this is written.
   */
  private toolBlock(note?: string): string {
    if (!note) return '';
    return (
      `SOMETHING WAS JUST DONE FOR HIM in one of his connected services, and this is what came back. ` +
      `Report it in one or two short sentences — what happened, and the key detail (a number, a name, a link) if there is one. ` +
      `It really happened; never say you cannot do things, and never claim anything beyond what is written here.\n${note}\n\n`
    );
  }

  private async buildAnswerPrompt(session: any, recent: any[], text: string, hits: MemHit[], didSearch: boolean, toolNote?: string): Promise<string> {
    const convo = recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`).join('\n').slice(-3000);
    const tool = this.toolBlock(toolNote);

    // Per-document chat: the single excerpt IS the document the user is asking about.
    if (session.docId) {
      return (
        `You are answering questions about ONE specific document for the user. The FULL document is provided below. ` +
        `Answer only from this document, in clean Markdown (short paragraphs, **bold**, bullet lists). Be direct and helpful. ` +
        `If the document doesn't cover the question, say so briefly. NEVER claim you don't have a document — it is right here.\n\n` +
        (convo ? `Conversation so far:\n${convo}\n\n` : '') +
        tool +
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
      tool +
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

  private async answer(session: any, recent: any[], text: string, hits: MemHit[], didSearch: boolean, toolNote?: string): Promise<{ answer: string; followups: string[] }> {
    const raw = (await this.llm.completeWith(await this.getModel(), await this.buildAnswerPrompt(session, recent, text, hits, didSearch, toolNote), 800, 'chat').catch(this.budgetText)) || '';
    return this.splitAnswer(raw);
  }

  /**
   * Like sendMessage but streams answer tokens via onToken; saves + returns the final messages.
   *
   * `onNote` is the one-line "Using GitHub: Create an issue…" while a real API call is in flight —
   * a service hop can take a couple of seconds, and an empty bubble for two seconds reads as broken.
   */
  async streamMessage(sessionId: string, text: string, onToken: (t: string) => void, onNote?: (n: string) => void) {
    const session = await this.prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session) return null;
    const clean = (text || '').trim();
    if (!clean) return null;

    const recentRows = await this.prisma.chatMessage.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 8 });
    const recent = recentRows.reverse();
    const userMsg = await this.prisma.chatMessage.create({ data: { sessionId, role: 'user', content: clean } });

    // Outside services first: a gate must stop the turn before a single token is streamed.
    const acted = await this.toolPhase(recent, clean, sessionId, userMsg.id, onNote);
    if (acted?.gate || acted?.failed) return this.actedReply(session, sessionId, clean, userMsg, acted);

    let hits: MemHit[] = [];
    let sources: Source[] = [];
    let didSearch = true;
    if (session.docId) {
      hits = await this.docHits(session.docId);
      sources = hits.length ? [{ title: session.title || 'Document', itemId: session.docId }] : [];
    } else if (!acted?.note) {
      // Skipped when a service just answered this turn: "here are your repositories" is not a
      // question about his saved notes, and four unrelated source chips under it are noise.
      const route = await this.route(session, recent, clean);
      didSearch = route.search;
      if (route.search) {
        const f = scopeFilter(session.scope);
        hits = await this.memory.searchScoped(route.query || clean, f.include, 5, f.exclude);
      }
      sources = await this.toSources(hits);
    } else {
      didSearch = false;
    }

    const prompt = await this.buildAnswerPrompt(session, recent, clean, hits, didSearch, acted?.note);
    const cfg = await this.getModel();
    const full = (await this.llm.completeStream(cfg, prompt, 800, onToken, 'chat').catch(this.budgetText)) || '';
    const { answer, followups } = this.splitAnswer(full);

    const aMsg = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: answer,
        sources: JSON.stringify(sources),
        followups: JSON.stringify(followups),
        tools: acted?.chips?.length ? JSON.stringify(acted.chips) : null,
      },
    });
    await this.touch(session, sessionId, clean);

    return { userMessage: this.shapeMessage(userMsg), message: this.shapeMessage(aMsg) };
  }

  /** Map memory hits to clickable sources (link to our internal Item when we can match it). */
  private async toSources(hits: MemHit[]): Promise<Source[]> {
    const out: Source[] = [];
    const seen = new Set<string>();
    // Resolve every hit's store-doc id back to its real app row in one batch, so a source can deep-link
    // to the actual item (vault, task, idea, meeting, story, note, doc…) — not just documents. (BEA-373)
    const resolved = await this.memory.resolveRefs(hits.map((h) => h.memId).filter(Boolean) as string[]);
    for (const h of hits) {
      let itemId: string | undefined;
      let title = h.title;
      let url = h.url;
      let link: string | undefined;
      let sourceType: string | undefined;
      const ent = h.memId ? resolved[h.memId] : undefined;
      if (ent) {
        const dl = deepLinkFor(ent);
        link = dl.link;
        sourceType = dl.sourceType;
        if (ent.type === 'item') {
          // Enrich documents with their title + original url (kept for back-compat with /doc links).
          const it = await this.prisma.item.findUnique({ where: { id: ent.id }, select: { id: true, title: true, sourceUrl: true } });
          if (it) {
            itemId = it.id;
            title = title || it.title || 'Saved item';
            url = url || it.sourceUrl || undefined;
          }
        }
      }
      const key = link || itemId || url || title;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ title: title || 'Memory', url, itemId, link, sourceType });
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
