import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, LlmConfig } from '../llm/llm.service';
import { GoogleService } from './google.service';
import { ItemsService } from '../items/items.service';
import { MemoryService } from '../memory/memory.service';
import { TasksService } from '../tasks/tasks.service';

const MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.6' };
const QUERY_MODEL: LlmConfig = { provider: 'openrouter', model: 'anthropic/claude-haiku-4.5' }; // tiny job: NL → Gmail query

/** Strip filler words as a safe fallback when the AI query step is unavailable. */
const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'there', 'here', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we', 'our', 'find', 'show', 'search', 'email', 'emails', 'mail', 'about', 'regarding', 'related', 'to', 'of', 'for', 'on', 'in', 'and', 'or', 'with', 'please', 'any', 'some', 'me', 'where', 'which', 'discussion', 'thread', 'get', 'give']);
function keywordize(nl: string): string {
  const words = nl
    .toLowerCase()
    .replace(/[^a-z0-9@.\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w));
  return (words.length ? words : nl.split(/\s+/)).join(' ').trim();
}

type Thread = { subject: string; copy: string; messages: { from: string; date: string; body: string }[] };

/** Turns a natural-language email search into a saved AI briefing of one thread. */
@Injectable()
export class GmailRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly google: GoogleService,
    private readonly items: ItemsService,
    private readonly memory: MemoryService,
    private readonly tasks: TasksService,
  ) {}

  /** Turn a natural-language ask into a tight Gmail query (keywords + safe operators). */
  private async buildGmailQuery(nl: string): Promise<string> {
    const raw = (nl || '').trim();
    if (!raw) return '';
    const prompt =
      `Convert this natural-language request into a concise Gmail search query.\n` +
      `Rules: keep ONLY the meaningful keywords; drop filler words (there is, an email, regarding, about, please, find, show, etc.). ` +
      `You MAY use Gmail operators (from:, to:, subject:, has:attachment, after:YYYY/MM/DD) only when clearly implied by the request. ` +
      `Do NOT add quotes unless a multi-word phrase must stay exact. Return ONLY the query on a single line, nothing else.\n\n` +
      `Request: ${raw}\nGmail query:`;
    const out = (await this.llm.completeWith(QUERY_MODEL, prompt, 60, 'gmail-query'))?.trim() || '';
    const cleaned = out.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').replace(/^Gmail query:\s*/i, '').trim();
    return cleaned || keywordize(raw);
  }

  /** Step 1 — find the top matching threads for the user to pick from. */
  async search(query: string) {
    const q = (query || '').trim();
    if (!q) return { threads: [], gmailQuery: '' };
    const gmailQuery = await this.buildGmailQuery(q);
    return { threads: await this.google.gmailSearchThreads(gmailQuery || q, 5), gmailQuery };
  }

  private shape(r: any) {
    return {
      id: r.id,
      query: r.query,
      title: r.title,
      threadId: r.threadId,
      threadSubject: r.threadSubject,
      summary: r.summary,
      shared: r.shared,
      shareId: r.shareId,
      itemId: r.itemId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private autoTitle(query: string): string {
    const t = (query || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Email request';
  }

  private async summarize(query: string, thread: Thread, messageCount: number): Promise<string> {
    const prompt =
      `The user searched their email for: "${query}".\n` +
      `Below is the FULL email thread "${thread.subject}" — all ${messageCount} message(s), oldest first, with quoted reply history already removed. ` +
      `Cover the WHOLE back-and-forth, not just the first message. Write a clean briefing:\n` +
      `- **Description** — 2–4 sentences on what this thread is about and where it stands now.\n` +
      `- **The conversation** — a short chronological walk-through of who said/asked/decided what across the messages.\n` +
      `- **Key points** — bullets: decisions, numbers, dates, commitments, open questions.\n` +
      `- **Action items / next steps** — bullets, only if there are real ones.\n` +
      `Use plain Markdown. No preamble, no sign-off.\n\n` +
      `=== EMAIL THREAD (${messageCount} messages) ===\n${thread.copy.slice(0, 60000)}`;
    return (await this.llm.completeWith(MODEL, prompt, 1600, 'gmail-request'))?.trim() || 'Could not summarise this thread.';
  }

  /** Step 2 — build + save the request from the chosen thread. */
  /** Index an Email Request into Explore (mandatory section). (BEA-336) */
  private indexRequest(row: any): void {
    if (!row?.id) return;
    const content = [row.title, row.query, row.threadSubject, row.summary].filter(Boolean).join('\n\n');
    if (!content.trim()) return;
    this.memory
      .indexEntity({
        refType: 'gmailrequest',
        refId: row.id,
        title: row.title || 'Email request',
        content,
        tags: ['email', 'request'],
        prevSupermemoryId: row.supermemoryId,
        prevRagId: row.ragId,
      })
      .catch(() => undefined);
  }

  async create(query: string, threadId: string, title?: string) {
    const thread = await this.google.gmailThread(threadId);
    const summary = await this.summarize(query, thread, thread.messages.length);
    const row = await this.prisma.gmailRequest.create({
      data: {
        query: (query || '').trim().slice(0, 500),
        title: title?.trim()?.slice(0, 120) || this.autoTitle(query),
        threadId,
        threadSubject: thread.subject,
        summary,
        emailCopy: thread.copy.slice(0, 60000),
      },
    });
    this.indexRequest(row);
    return this.shape(row);
  }

  /** Re-run the whole search + summary to rebuild a frozen request. */
  async refresh(id: string) {
    const r = await this.prisma.gmailRequest.findUnique({ where: { id } });
    if (!r) return null;
    let threadId = r.threadId;
    if (!threadId) {
      const gq = await this.buildGmailQuery(r.query);
      const hits = await this.google.gmailSearchThreads(gq || r.query, 1);
      threadId = hits[0]?.threadId || null;
    }
    if (!threadId) return this.shape(r);
    const thread = await this.google.gmailThread(threadId);
    const summary = await this.summarize(r.query, thread, thread.messages.length);
    const row = await this.prisma.gmailRequest.update({
      where: { id },
      data: { threadId, threadSubject: thread.subject, summary, emailCopy: thread.copy.slice(0, 60000) },
    });
    this.indexRequest(row);
    return this.shape(row);
  }

  async list() {
    const rows = await this.prisma.gmailRequest.findMany({ orderBy: { createdAt: 'desc' } });
    return { requests: rows.map((r) => this.shape(r)) };
  }

  async get(id: string) {
    const r = await this.prisma.gmailRequest.findUnique({ where: { id } });
    return r ? this.shape(r) : null;
  }

  async rename(id: string, title: string) {
    const t = (title || '').trim().slice(0, 120);
    if (!t) return this.get(id);
    const r = await this.prisma.gmailRequest.update({ where: { id }, data: { title: t } }).catch(() => null);
    return r ? this.shape(r) : null;
  }

  /** Delete one of the user's own saved requests (by id — never bulk). */
  async remove(id: string) {
    await this.prisma.gmailRequest.delete({ where: { id } }).catch(() => null);
    return { ok: true };
  }

  /** Toggle the public share link. */
  async setShared(id: string, shared: boolean) {
    const r = await this.prisma.gmailRequest.findUnique({ where: { id } });
    if (!r) return null;
    const shareId = shared ? r.shareId || randomUUID() : r.shareId;
    const row = await this.prisma.gmailRequest.update({ where: { id }, data: { shared, shareId } });
    return { shared: row.shared, shareId: row.shareId, url: row.shared && row.shareId ? `/request-view/${row.shareId}` : null };
  }

  /** Public, unauthenticated read of a shared request. */
  async getShared(shareId: string) {
    const r = await this.prisma.gmailRequest.findUnique({ where: { shareId } });
    if (!r || !r.shared) return null;
    return { title: r.title, threadSubject: r.threadSubject, summary: r.summary, createdAt: r.createdAt };
  }

  /** Save to memory the "Alex" way (RAG + SuperMemory/Honcho), without making a Capture list item. */
  async saveMemory(id: string) {
    const r = await this.prisma.gmailRequest.findUnique({ where: { id } });
    if (!r) return null;
    await this.memory.enqueue(`Email briefing — ${r.title}\n\n${r.summary}`, { title: r.title, tags: ['email', 'gmail'] });
    return { ok: true };
  }

  /** Import the full briefing into Capture (also dual-writes to memory). */
  async importCapture(id: string) {
    const r = await this.prisma.gmailRequest.findUnique({ where: { id } });
    if (!r) return null;
    const content = `# ${r.title}\n\n${r.summary}${r.emailCopy ? `\n\n---\n\n## Source email\n\n${r.emailCopy}` : ''}`;
    const { item } = await this.items.store(content, 'gmail-request', r.title, undefined, ['email']);
    await this.prisma.gmailRequest.update({ where: { id }, data: { itemId: item.id } });
    return { id: item.id, title: item.title };
  }

  /** Extract concrete action items from the briefing and create real tasks. */
  async toTasks(id: string) {
    const r = await this.prisma.gmailRequest.findUnique({ where: { id } });
    if (!r) return { created: [] };
    const prompt =
      `From the email briefing below, extract concrete action items FOR THE USER as JSON: {"tasks":[{"title":"..."}]}. ` +
      `Only real, actionable next steps the user must do; return {"tasks":[]} if there are none. Keep each title short and imperative.\n\n${r.summary}`;
    const raw = (await this.llm.completeWith(MODEL, prompt, 500, 'gmail-request-tasks'))?.trim() || '';
    let titles: string[] = [];
    try {
      const json = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
      if (Array.isArray(json?.tasks)) titles = json.tasks.map((t: any) => String(t?.title || '').trim()).filter(Boolean);
    } catch {
      titles = [];
    }
    const created = [];
    for (const title of titles.slice(0, 8)) {
      const task = await this.tasks.create({ title, category: 'Email', sphere: 'work', tags: ['email'] }).catch(() => null);
      if (task) created.push({ id: (task as any).id, title: (task as any).title });
    }
    return { created };
  }
}
