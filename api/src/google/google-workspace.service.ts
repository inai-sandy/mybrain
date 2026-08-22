import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { DocumentsService } from '../documents/documents.service';
import { PrismaService } from '../prisma/prisma.service';
import { ComposioProvider } from '../tools/composio.provider';
import { ExecuteResult, ServiceAccount, ServiceProvider, serviceToolId } from '../tools/service-provider';
import { collectAttachments, extractBody, headerMap, importantDayQuery, importantSinceQuery, safeFilename, stripQuoted, unreadDayQuery } from './gmail-parse';
import { EARLY_AT, FINAL_AT, nextWindow, startOfLocalDay } from './gmail-schedule';

/**
 * Google Workspace through the ServiceProvider seam (BEA-1351). Design: `specs/TOOLS.md` → step 7.
 *
 * This replaces `google.service.ts`, which drove a Google CLI (`gws`) on the host through a bridge
 * logged in as ONE account on ONE machine. That could read the owner's mail but never a customer's,
 * and never a second inbox. Every read here goes through `provider.execute()` with a `svc:` id, so
 * it runs on whatever account is connected at `/tools`, and every call is written to the `ToolCall`
 * flight recorder like every other outside call.
 *
 * What was proven live before this was written (2026-08-17, same inbox on both roads):
 *  - Gmail hands back Google's OWN message payload on both roads — identical byte for byte, save the
 *    per-fetch attachment ids Gmail rotates anyway — so the parsing (`gmail-parse.ts`) is shared and
 *    unchanged, and only the transport differs.
 *  - The same day's important-mail set, unread count, thread messages, attachment bytes (sha1),
 *    Drive Sheet→xlsx export (every zip entry) and PDF download bytes all matched.
 *
 * Shapes this file knows, and nothing above it does:
 *  - Gmail list answers come back with metadata already on them (`sender`, `subject`, `preview.body`
 *    = Google's snippet, `payload.headers`, `messageTimestamp`) — one call where the bridge needed
 *    one per message. They arrive in ARRIVAL order, not Gmail's, so they are re-sorted by timestamp
 *    to match what the bridge produced (a brief numbers its emails).
 *  - Binary content (an attachment, a Drive download or export) is not in the answer: the provider
 *    stages the bytes and hands back a short-lived download URL. `bytesFrom()` is the one place that
 *    fetches it.
 *  - `GOOGLECALENDAR_EVENTS_LIST` ships a STALE default `timeMax` (a date in 2025) — left unset it
 *    silently answers "no events". It is always passed here.
 *  - `GOOGLEDRIVE_GET_FILE_METADATA` returns only id/name/mimeType, whatever fields are asked for.
 *    The link and size a Drive import needs come from a second, by-name search.
 */

/** Our keys for a Workspace service → the provider's toolkit slug. Never a vendor's name in an id. */
const TOOLKIT: Record<string, string> = {
  gmail: 'gmail',
  drive: 'googledrive',
  calendar: 'googlecalendar',
  docs: 'googledocs',
  sheets: 'googlesheets',
  slides: 'googleslides',
  tasks: 'googletasks',
  meet: 'googlemeet',
  chat: 'google_chat',
  // Forms are read through Drive (by mime type) and Contacts through Gmail's People access — the
  // same roads the bridge used, so neither needs a login of its own.
  forms: 'googledrive',
  contacts: 'gmail',
};

/** What the owner sees a toolkit called at /tools — for the "connect X first" sentence. */
export const TOOLKIT_LABEL: Record<string, string> = {
  gmail: 'Gmail',
  googledrive: 'Google Drive',
  googlecalendar: 'Google Calendar',
  googledocs: 'Google Docs',
  googlesheets: 'Google Sheets',
  googleslides: 'Google Slides',
  googletasks: 'Google Tasks',
  googlemeet: 'Google Meet',
  google_chat: 'Google Chat',
};

/** All Workspace services we surface. `unsupported` = Google gives no API for it at all. */
const SERVICE_MAP: { key: string; label: string; unsupported?: boolean }[] = [
  { key: 'gmail', label: 'Gmail' },
  { key: 'drive', label: 'Drive' },
  { key: 'docs', label: 'Docs' },
  { key: 'sheets', label: 'Sheets' },
  { key: 'slides', label: 'Slides' },
  { key: 'calendar', label: 'Calendar' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'forms', label: 'Forms' },
  { key: 'meet', label: 'Meet' },
  { key: 'chat', label: 'Chat' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'keep', label: 'Keep', unsupported: true },
];

/** The most we will pull down for one file — the same cap the bridge enforced. */
const MAX_BYTES = 40 * 1024 * 1024;
/** How long we give the provider to build a Drive export or fetch a big attachment. */
const BINARY_TIMEOUT_MS = 120_000;
/** Where the connected Gmail address is remembered — read once, kept until the account changes. (BEA-1399) */
const EMAIL_SETTING = 'google.email';
const EMAIL_ACCOUNT_SETTING = 'google.emailAccount';
/** A failed address probe is not retried before this — a page open must never become a Gmail call each. */
const EMAIL_RETRY_MS = 6 * 60 * 60 * 1000;
/** The Gmail daily call cap Setting, its default, and what a call past it is recorded as. (BEA-1399) */
const CAP_SETTING = 'gmail.dailyCap';
const DEFAULT_CAP = 60;
const CAP_ERROR = 'gmail-cap';
/** Rows in the flight recorder that never reached the vendor — they are not calls and are not counted. */
const NOT_A_CALL = new Set([CAP_ERROR, 'not-connected']);
const DEFAULT_TZ = 'Asia/Kolkata';
/** Rough size of a response, for the log — a number, never the content. */
function safeSize(data: any): string {
  try {
    const n = JSON.stringify(data).length;
    return n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
  } catch { return ''; }
}

/** Google-native → the Office format that keeps the most structure, plus the extension anydoc needs. */
const EXPORT_AS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
  'application/vnd.google-apps.presentation': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: '.pptx' },
};

export type GmailMeta = { id: string; threadId: string; from: string; subject: string; date: string; snippet: string };

@Injectable()
export class GoogleWorkspaceService {
  private readonly logger = new Logger(GoogleWorkspaceService.name);
  /** When the last address probe failed (in memory — a restart may try once more, which is bounded by the cap). */
  private emailProbeFailedAt = 0;

  // Optional deps go LAST — spec files build this service positionally with fewer args.
  constructor(
    private readonly provider: ComposioProvider,
    private readonly docs?: DocumentsService,
    private readonly prisma?: PrismaService,
  ) {}

  /** The Documents library. Optional in the constructor for the spec harnesses, so guard the use. */
  private get library(): DocumentsService {
    if (!this.docs) throw new Error('The documents library isn’t available right now.');
    return this.docs;
  }

  // ---- connection state -------------------------------------------------------------------

  /**
   * Is Google usable? "Connected" means Gmail is — it is the service every daily feature reads.
   * Offline-safe: a provider that cannot be reached answers connected:false, never throws.
   */
  async status(): Promise<{ connected: boolean; email: string | null; gmail: boolean; drive: boolean; calendar: boolean }> {
    const [gmail, drive, calendar] = await Promise.all([this.account('gmail'), this.account('drive'), this.account('calendar')]);
    const email = gmail ? await this.connectedEmail().catch(() => null) : null;
    return { connected: !!gmail, email, gmail: !!gmail, drive: !!drive, calendar: !!calendar };
  }

  /** Per-service state for the Settings → Google tab. `access` keeps its old vocabulary for the UI. */
  async services(): Promise<{ connected: boolean; email: string | null; project: string | null; services: { key: string; label: string; access: string; enabled: boolean; unsupported: boolean; connect: string | null }[] }> {
    const st = await this.status();
    const services = await Promise.all(
      SERVICE_MAP.map(async (svc) => {
        const on = !svc.unsupported && !!(await this.account(svc.key));
        return { key: svc.key, label: svc.label, access: on ? 'read-write' : 'off', enabled: on, unsupported: !!svc.unsupported, connect: svc.unsupported ? null : TOOLKIT[svc.key] || null };
      }),
    );
    return { connected: st.connected, email: st.email, project: null, services };
  }

  /**
   * The address of the connected Gmail account. Remembered in a Setting after ONE counted probe and
   * never asked for again — before this it was re-probed every 30 min by a ticker nobody read,
   * and the probe was kept out of the flight recorder while Composio counted every one. (BEA-1399)
   */
  private async connectedEmail(): Promise<string | null> {
    return this.rememberEmail();
  }

  /**
   * Read the remembered address, or learn it once (a counted GET_PROFILE) and keep it, together with
   * the account it belongs to — a reconnected Gmail (a different account id at /tools) is learned
   * again, so the old address is never shown for the new login. A probe that FAILS is not retried for
   * `EMAIL_RETRY_MS`: the pages call status() on every open, and a bad hour must not become a Gmail
   * call per page view eating the cap the scheduled reads need.
   */
  async rememberEmail(): Promise<string | null> {
    const account = await this.account('gmail');
    if (!account) return null;
    const [saved, savedFor] = await Promise.all([this.setting(EMAIL_SETTING), this.setting(EMAIL_ACCOUNT_SETTING)]);
    if (saved && (!savedFor || savedFor === account.id)) return saved;
    if (Date.now() - this.emailProbeFailedAt < EMAIL_RETRY_MS) return null;
    let email: string | null = null;
    try {
      const d = await this.call('gmail', 'GET_PROFILE', {});
      email = String(d?.response_data?.emailAddress || d?.emailAddress || '').trim() || null;
    } catch {
      email = null;
    }
    if (!email) {
      this.emailProbeFailedAt = Date.now();
      return null;
    }
    await this.setSetting(EMAIL_SETTING, email);
    await this.setSetting(EMAIL_ACCOUNT_SETTING, String(account.id || ''));
    return email;
  }

  private async setting(key: string): Promise<string | null> {
    try {
      const row = await this.prisma?.setting?.findUnique?.({ where: { key } });
      return row?.value ? String(row.value) : null;
    } catch {
      return null;
    }
  }
  private async setSetting(key: string, value: string): Promise<void> {
    try {
      await this.prisma?.setting?.upsert?.({ where: { key }, create: { key, value }, update: { value } });
    } catch {
      /* a missing Settings table in a harness is not an error */
    }
  }
  private async tz(): Promise<string> {
    return (await this.setting('tasks.tz')) || DEFAULT_TZ;
  }
  private dayKey(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }
  private localHM(tz: string, d = new Date()): string {
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
    } catch {
      return d.toISOString().slice(11, 16);
    }
  }

  // ---- the Gmail daily cap and counter (BEA-1399) ------------------------------------------

  /** The cap (calls per local day). 0 = no cap. */
  async gmailCap(): Promise<number> {
    const raw = await this.setting(CAP_SETTING);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_CAP;
  }
  async setGmailCap(cap: number): Promise<number> {
    if (!Number.isFinite(cap) || cap < 0 || cap > 100_000) throw new Error('The cap must be a whole number of calls per day (0 = no cap).');
    const n = Math.floor(cap);
    await this.setSetting(CAP_SETTING, String(n));
    return n;
  }

  /** Today's real Gmail calls (rows that reached the vendor), newest first. */
  private async gmailCallsToday(): Promise<{ action: string; ok: boolean; createdAt: Date }[]> {
    const since = startOfLocalDay(await this.tz());
    try {
      const rows: any[] = (await this.prisma?.toolCall?.findMany?.({ where: { service: 'gmail', createdAt: { gte: since } }, select: { action: true, ok: true, error: true, createdAt: true } })) || [];
      return rows
        .filter((r) => !r?.error || !NOT_A_CALL.has(String(r.error)))
        .map((r) => ({ action: String(r.action || ''), ok: !!r.ok, createdAt: new Date(r.createdAt) }))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    } catch {
      return [];
    }
  }

  /** The counter the Google page and Settings show: calls today, the cap, what they were, and the next scheduled read. */
  async gmailUsage(): Promise<{ day: string; tz: string; calls: number; cap: number; byAction: { action: string; n: number }[]; last: string | null; schedule: { early: string; final: string }; next: { time: string; day: 'today' | 'tomorrow' } }> {
    const tz = await this.tz();
    const [rows, cap] = await Promise.all([this.gmailCallsToday(), this.gmailCap()]);
    const by = new Map<string, number>();
    for (const r of rows) {
      const short = r.action.replace(/^svc:gmail\./, '');
      by.set(short, (by.get(short) || 0) + 1);
    }
    const byAction = [...by.entries()].map(([action, n]) => ({ action, n })).sort((a, b) => b.n - a.n || a.action.localeCompare(b.action));
    return {
      day: this.dayKey(tz),
      tz,
      calls: rows.length,
      cap,
      byAction,
      last: rows[0]?.createdAt?.toISOString?.() || null,
      schedule: { early: EARLY_AT, final: FINAL_AT },
      next: nextWindow(this.localHM(tz)),
    };
  }

  /** Throws `gmail-cap:<calls>:<cap>` when today's count has reached the cap. */
  private async assertUnderGmailCap(): Promise<void> {
    const cap = await this.gmailCap();
    if (!cap) return;
    const calls = (await this.gmailCallsToday()).length;
    if (calls >= cap) throw new Error(`${CAP_ERROR}:${calls}:${cap}`);
  }

  // ---- Gmail --------------------------------------------------------------------------------

  /** Recent (optionally searched) messages with From/Subject/Date/snippet. */
  async gmailList(q?: string): Promise<{ id: string; from: string; subject: string; date: string; snippet: string }[]> {
    const metas = await this.gmailMetas(q?.trim() ? q.trim() : '', 15);
    return metas.map(({ threadId: _t, ...m }) => m);
  }

  /** Unread messages received on a specific local day — the real ids counted, never the estimate. (BEA-615) */
  async gmailDayUnread(day: string): Promise<number | null> {
    const d = await this.call('gmail', 'FETCH_EMAILS', { query: unreadDayQuery(day), max_results: 500, ids_only: true });
    return Array.isArray(d?.messages) ? d.messages.length : null;
  }

  /** The "important" emails received on a local day — Promotions/Social/Updates + Chats excluded. */
  async gmailImportantForDay(day: string, max = 25): Promise<GmailMeta[]> {
    return this.gmailMetas(importantDayQuery(day), max);
  }

  /** The same, but only what arrived after `sinceEpochSeconds` — the final pass's read. (BEA-1399) */
  async gmailImportantSince(day: string, sinceEpochSeconds: number, max = 25): Promise<GmailMeta[]> {
    return this.gmailMetas(importantSinceQuery(day, sinceEpochSeconds), max);
  }

  /** Search Gmail and return up to `max` distinct matching threads (newest message per thread). */
  async gmailSearchThreads(query: string, max = 5): Promise<{ threadId: string; subject: string; from: string; date: string; snippet: string }[]> {
    const metas = await this.gmailMetas(query, 20);
    const seen = new Set<string>();
    const out: { threadId: string; subject: string; from: string; date: string; snippet: string }[] = [];
    for (const m of metas) {
      if (out.length >= max) break;
      if (seen.has(m.threadId)) continue;
      seen.add(m.threadId);
      out.push({ threadId: m.threadId, subject: m.subject, from: m.from, date: m.date, snippet: m.snippet });
    }
    return out;
  }

  /** Fetch a whole Gmail thread as readable text (subject + each message's from/date/body). */
  async gmailThread(threadId: string): Promise<{ subject: string; copy: string; messages: { from: string; date: string; body: string }[] }> {
    const raw = await this.threadMessages(threadId);
    const messages = raw.map((m) => {
      const h = headerMap(m?.payload);
      const body = extractBody(m?.payload) || this.snippetOf(m) || '';
      return { from: h.from || '', date: h.date || '', subject: h.subject || '', body: stripQuoted(body).slice(0, 6000) };
    });
    const subject = messages.find((m) => m.subject)?.subject || '(no subject)';
    const copy = messages.map((m, i) => `--- Message ${i + 1} of ${messages.length} ---\nFrom: ${m.from}\nDate: ${m.date}\n\n${m.body}`).join('\n\n');
    return { subject, copy, messages };
  }

  /** Full plain-text body of ONE message (de-quoted, capped). For storing important emails in memory. (BEA-439) */
  async gmailMessageFull(id: string): Promise<string> {
    const m = await this.call('gmail', 'FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: id, format: 'full' });
    const raw = extractBody(m?.payload) || this.snippetOf(m) || '';
    return stripQuoted(raw).slice(0, 20000);
  }

  /**
   * Import one email into the Documents library, in the "Email" folder — the message itself plus
   * every readable attachment as its own document. (BEA-1341)
   */
  async gmailImport(id: string): Promise<{ id: string; title: string; attachments: number }> {
    const m = await this.call('gmail', 'FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: id, format: 'full' });
    const h = headerMap(m?.payload);
    const subject = h.subject || '(no subject)';
    const body = extractBody(m?.payload) || this.snippetOf(m) || '';
    const threadId = m?.threadId;
    const link = threadId ? `https://mail.google.com/mail/u/0/#inbox/${threadId}` : undefined;
    const md = [
      `# ${subject}`,
      '',
      `**From:** ${h.from || 'unknown'}  `,
      h.to ? `**To:** ${h.to}  ` : '',
      `**Date:** ${h.date || ''}`,
      '',
      body,
    ].filter((l) => l !== '').join('\n').trim();

    const collectionId = await this.library.ensureCollection('Email', 'Mail');
    const doc: any = await this.library.createFromUpload(
      { originalname: `${safeFilename(subject)}.md`, mimetype: 'text/markdown', buffer: Buffer.from(md, 'utf8') },
      { collectionId, sourceUrl: link },
    );

    // Each attachment becomes its own document in the same folder, so it is readable and searchable.
    let saved = 0;
    for (const att of collectAttachments(m?.payload)) {
      try {
        const buffer = await this.attachmentBytes(id, att.attachmentId, att.filename);
        if (!buffer.length) continue;
        await this.library.createFromUpload(
          { originalname: att.filename, mimetype: att.mimeType, buffer, size: buffer.length },
          { collectionId, sourceUrl: link },
        );
        saved++;
      } catch (e) {
        // One unreadable attachment must not lose the email itself.
        this.logger.warn(`gmail attachment "${att.filename}" skipped: ${String((e as Error)?.message || e)}`);
      }
    }
    return { id: doc.id, title: doc.title, attachments: saved };
  }

  /**
   * Save a whole email conversation into Documents, in the "Email" folder: one document for the
   * thread, plus every attachment found on any message in it. (BEA-1341)
   */
  async gmailThreadImport(threadId: string): Promise<{ id: string; title: string; attachments: number }> {
    const messages = await this.threadMessages(threadId);
    if (!messages.length) throw new Error('That email could not be read.');

    const subject = messages.map((m) => headerMap(m?.payload).subject).find(Boolean) || '(no subject)';
    const parts = messages.map((m, i) => {
      const h = headerMap(m?.payload);
      const body = stripQuoted(extractBody(m?.payload) || this.snippetOf(m) || '');
      const head = messages.length > 1 ? `## Message ${i + 1} of ${messages.length}\n\n` : '';
      return `${head}**From:** ${h.from || 'unknown'}  \n**Date:** ${h.date || ''}\n\n${body}`;
    });
    const md = `# ${subject}\n\n${parts.join('\n\n---\n\n')}`.trim();

    const collectionId = await this.library.ensureCollection('Email', 'Mail');
    const link = `https://mail.google.com/mail/u/0/#all/${threadId}`;
    const emailFile = `${safeFilename(subject)}.md`;

    // Saving the same conversation twice refreshes it (a thread grows new replies) instead of
    // leaving a second copy in the folder. (BEA-1341)
    const already = await this.library.findImported(link, emailFile);
    const doc: any = already
      ? await this.library.replaceContent(already.id, md)
      : await this.library.createFromUpload(
          { originalname: emailFile, mimetype: 'text/markdown', buffer: Buffer.from(md, 'utf8') },
          { collectionId, sourceUrl: link },
        );

    let saved = 0;
    for (const m of messages) {
      const messageId = m?.messageId || m?.id;
      for (const att of collectAttachments(m?.payload)) {
        try {
          // Key on the attachment's own id, hashed short: two files in one thread can share a name,
          // and a raw Gmail attachment id runs 400 characters. (BEA-1344)
          const attLink = `${link}#att=${createHash('sha1').update(att.attachmentId).digest('hex').slice(0, 16)}`;
          if (await this.library.findImported(attLink, att.filename)) continue; // already brought in
          const buffer = await this.attachmentBytes(messageId, att.attachmentId, att.filename);
          if (!buffer.length) continue;
          await this.library.createFromUpload(
            { originalname: att.filename, mimetype: att.mimeType, buffer, size: buffer.length },
            { collectionId, sourceUrl: attLink },
          );
          saved++;
        } catch (e) {
          this.logger.warn(`gmail attachment "${att.filename}" skipped: ${String((e as Error)?.message || e)}`);
        }
      }
    }
    return { id: doc.id, title: doc.title, attachments: saved };
  }

  /** Count of unread inbox messages (Gmail's own estimate — one cheap call, as before). */
  async gmailUnreadCount(): Promise<number | null> {
    const d = await this.call('gmail', 'FETCH_EMAILS', { query: 'is:unread in:inbox', max_results: 1, ids_only: true });
    const n = Number(d?.resultSizeEstimate);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * Up to `max` messages matching `query`, with the metadata every list here needs, in Gmail's own
   * order (newest first). One call: the provider fetches the metadata for us, concurrently — which is
   * also why the answer arrives in arrival order and is re-sorted by timestamp here.
   */
  private async gmailMetas(query: string, max: number): Promise<GmailMeta[]> {
    const args: Record<string, any> = { max_results: max, verbose: false };
    if (query) args.query = query;
    const d = await this.call('gmail', 'FETCH_EMAILS', args);
    const rows: any[] = Array.isArray(d?.messages) ? d.messages : [];
    return rows
      .filter((m) => m?.messageId)
      .sort((a, b) => String(b?.messageTimestamp || '').localeCompare(String(a?.messageTimestamp || '')))
      .slice(0, max)
      .map((m) => {
        const h = headerMap(m?.payload);
        return {
          id: String(m.messageId),
          threadId: String(m.threadId || m.messageId),
          from: h.from || m.sender || '',
          subject: h.subject || m.subject || '(no subject)',
          date: h.date || '',
          snippet: this.snippetOf(m),
        };
      });
  }

  /** Every message of a thread, oldest first — Google's own message objects. */
  private async threadMessages(threadId: string): Promise<any[]> {
    const d = await this.call('gmail', 'FETCH_MESSAGE_BY_THREAD_ID', { thread_id: threadId });
    return Array.isArray(d?.messages) ? d.messages : [];
  }

  /** Google's snippet — the provider calls it `preview.body`. */
  private snippetOf(m: any): string {
    return String(m?.preview?.body || m?.snippet || '');
  }

  /** The bytes of one attachment. The provider stages the file and hands back a short-lived link. */
  private async attachmentBytes(messageId: string, attachmentId: string, filename: string): Promise<Buffer> {
    const d = await this.call('gmail', 'GET_ATTACHMENT', { message_id: messageId, attachment_id: attachmentId, file_name: filename || 'attachment' }, { timeoutMs: BINARY_TIMEOUT_MS });
    const url = d?.file?.s3url || d?.file?.url;
    if (!url) throw new Error('Could not download that attachment.');
    return this.bytesFrom(String(url));
  }

  // ---- Drive --------------------------------------------------------------------------------

  async driveList(q?: string): Promise<{ id: string; name: string; mimeType: string; modified: string; link: string }[]> {
    const query = q?.trim() ? `name contains '${q.trim().replace(/'/g, "\\'")}' and trashed=false` : 'trashed=false';
    const d = await this.call('drive', 'FIND_FILE', { q: query, pageSize: 20, orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' });
    return ((d?.files as any[]) || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modified: f.modifiedTime, link: f.webViewLink }));
  }

  /**
   * Bring a Drive file into the Documents library, in the "Google Drive" folder. (BEA-1341)
   *
   * Google's own formats are exported as the matching Office format so headings, tables and every
   * sheet survive; real files stored in Drive are downloaded as-is.
   */
  async driveImport(id: string): Promise<{ id: string; title: string }> {
    const meta = await this.driveMeta(id);
    const name = String(meta?.name || 'Drive file');
    const mt = String(meta?.mimeType || '');
    const link = meta?.webViewLink || undefined;
    // Refuse early where we can. Drive only reports `size` for files with real stored bytes, so this
    // covers downloads but NOT Google-native exports; those are still capped after export. (BEA-1343)
    const declared = Number(meta?.size || 0);
    if (declared > MAX_BYTES) throw new Error(`“${name}” is too big to bring in (max 40 MB).`);

    let buffer: Buffer;
    let filename: string;
    let mime: string;
    const want = EXPORT_AS[mt];
    if (want) {
      buffer = await this.driveBytes(id, want.mime);
      // ALWAYS carry the export's own extension. A Doc titled "Report.pdf" is still a .docx once
      // exported, and trusting the title filed real Word bytes as a PDF. (BEA-1343)
      filename = name.toLowerCase().endsWith(want.ext) ? name : `${name}${want.ext}`;
      mime = want.mime;
    } else if (mt.startsWith('application/vnd.google-apps.')) {
      // Forms, Drawings, Sites and friends have no document form we can read.
      throw new Error(`“${name}” is a Google ${mt.split('.').pop()} — there’s no document to bring in.`);
    } else {
      buffer = await this.driveBytes(id);
      filename = name;
      mime = mt || 'application/octet-stream';
    }
    if (!buffer?.length) throw new Error('That file appears to be empty.');

    const collectionId = await this.library.ensureCollection('Google Drive', 'Folder');
    const upload = { originalname: filename, mimetype: mime, buffer, size: buffer.length };

    // Importing the same Drive file twice refreshes it, matched on the link alone — Drive keeps
    // webViewLink across a rename. (BEA-1343, BEA-1344)
    const already = link ? await this.library.findImported(link) : null;
    const doc: any = already
      ? await this.library.refreshFromUpload(already.id, upload)
      : await this.library.createFromUpload(upload, { collectionId, sourceUrl: link });
    return { id: doc.id, title: doc.title };
  }

  /**
   * A file's name, type, link and size. The metadata action answers with name and type only, so the
   * link and size come from a second, by-name search — best effort: without them the import still
   * works, it just cannot refresh an earlier copy or refuse a huge file before downloading it.
   */
  private async driveMeta(id: string): Promise<{ name: string; mimeType: string; webViewLink?: string; size?: string }> {
    const m = await this.call('drive', 'GET_FILE_METADATA', { fileId: id });
    const out: { name: string; mimeType: string; webViewLink?: string; size?: string } = { name: String(m?.name || ''), mimeType: String(m?.mimeType || ''), webViewLink: m?.webViewLink, size: m?.size };
    if (out.webViewLink) return out;
    try {
      const q = `name = '${out.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      const d = await this.call('drive', 'FIND_FILE', { q, pageSize: 20, fields: 'files(id,name,mimeType,webViewLink,size)' });
      const hit = ((d?.files as any[]) || []).find((f) => f?.id === id);
      if (hit) {
        out.webViewLink = hit.webViewLink || out.webViewLink;
        out.size = hit.size || out.size;
      }
    } catch (e) {
      this.logger.warn(`drive link lookup for ${id} skipped: ${String((e as Error)?.message || e)}`);
    }
    return out;
  }

  /** The bytes of a Drive file — exported to `mimeType` for a Google-native file, native otherwise. */
  private async driveBytes(id: string, mimeType?: string): Promise<Buffer> {
    const args: Record<string, any> = { file_id: id };
    if (mimeType) args.mime_type = mimeType;
    const d = await this.call('drive', 'DOWNLOAD_FILE', args, { timeoutMs: BINARY_TIMEOUT_MS });
    const url = d?.downloaded_file_content?.s3url || d?.downloaded_file_content?.url;
    if (!url) throw new Error('Could not download that file from Google.');
    return this.bytesFrom(String(url));
  }

  /** Google Forms owned/visible to the user (found via Drive by mime type). */
  async forms(): Promise<{ id: string; name: string; modified: string; link: string }[]> {
    const d = await this.call('drive', 'FIND_FILE', {
      q: "mimeType='application/vnd.google-apps.form' and trashed=false",
      pageSize: 30,
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,modifiedTime,webViewLink)',
    });
    return ((d?.files as any[]) || []).map((f) => ({
      id: f.id,
      name: f.name || 'Untitled form',
      modified: f.modifiedTime || '',
      link: f.webViewLink || `https://docs.google.com/forms/d/${f.id}/edit`,
    }));
  }

  // ---- Docs / Sheets / Slides (safe writes: create NEW only) ------------------------------

  /** Create a NEW Google Doc with the given text (safe write — never edits existing files). */
  async docCreate(title: string, content: string): Promise<{ id: string; link: string }> {
    const d = await this.call('docs', 'CREATE_DOCUMENT', { title: (title || 'Untitled').slice(0, 200), text: (content || '').slice(0, 100000) });
    const docId = d?.document_id || d?.documentId || d?.response_data?.documentId;
    if (!docId) throw new Error('Could not create the document.');
    return { id: docId, link: `https://docs.google.com/document/d/${docId}/edit` };
  }

  async sheetCreate(title: string): Promise<{ id: string; link: string }> {
    const d = await this.call('sheets', 'CREATE_GOOGLE_SHEET1', { title: (title || 'Untitled').slice(0, 200) });
    const id = d?.spreadsheetId || d?.response_data?.spreadsheetId;
    if (!id) throw new Error('Could not create the spreadsheet.');
    return { id, link: `https://docs.google.com/spreadsheets/d/${id}/edit` };
  }

  async slidesCreate(title: string): Promise<{ id: string; link: string }> {
    const d = await this.call('slides', 'PRESENTATIONS_CREATE', { title: (title || 'Untitled').slice(0, 200) });
    const id = d?.presentationId || d?.response_data?.presentationId;
    if (!id) throw new Error('Could not create the presentation.');
    return { id, link: `https://docs.google.com/presentation/d/${id}/edit` };
  }

  // ---- Calendar -----------------------------------------------------------------------------

  async calendar(): Promise<{ id: string; summary: string; start: string | null; end: string | null; location: string | null; link: string | null }[]> {
    const now = new Date();
    // `timeMax` is passed on purpose: the action's own default is a fixed date in the past, and
    // leaving it out returns an empty diary without a word of complaint (verified live 2026-08-17).
    const max = new Date(now.getTime() + 90 * 86_400_000);
    const d = await this.call('calendar', 'EVENTS_LIST', { calendarId: 'primary', maxResults: 12, timeMin: now.toISOString(), timeMax: max.toISOString(), singleEvents: true, orderBy: 'startTime' });
    return ((d?.items as any[]) || []).map((e) => ({
      id: e.id,
      summary: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      location: e.location || null,
      link: e.htmlLink || null,
    }));
  }

  // ---- Live hints for the launcher grid (cheap, best-effort) ------------------------------

  /** Small glance-able numbers for the Google tile grid. Never throws — missing bits come back null. */
  async hints(): Promise<{ connected: boolean; gmailUnread: number | null; gmailUnreadDay: string | null; calendarNext: { summary: string; start: string | null } | null; tasksOpen: number | null }> {
    const st = await this.status();
    if (!st.connected) return { connected: false, gmailUnread: null, gmailUnreadDay: null, calendarNext: null, tasksOpen: null };
    const [brief, calendarNext, tasksOpen] = await Promise.all([
      // The unread count comes from the STORED brief (the 21:00 / 23:30 read) — opening the page never calls Gmail. (BEA-1399)
      this.latestBrief(),
      this.calendar().then((evs) => (evs[0] ? { summary: evs[0].summary, start: evs[0].start } : null)).catch(() => null),
      // Google Tasks is its own login; with none connected there is nothing to count and no call to log.
      this.account('tasks').then((a) => (a ? this.tasks().then((lists) => lists.reduce((n, l) => n + l.tasks.length, 0)) : null)).catch(() => null),
    ]);
    return { connected: true, gmailUnread: brief ? brief.unread : null, gmailUnreadDay: brief ? brief.day : null, calendarNext, tasksOpen };
  }

  private async latestBrief(): Promise<{ day: string; unread: number | null } | null> {
    try {
      const row = await this.prisma?.gmailBrief?.findFirst?.({ orderBy: { day: 'desc' }, select: { day: true, unread: true } });
      return row ? { day: String(row.day), unread: Number.isFinite(Number(row.unread)) ? Number(row.unread) : null } : null;
    } catch {
      return null;
    }
  }

  // ---- Google Tasks -------------------------------------------------------------------------

  async tasks(): Promise<{ listId: string; title: string; tasks: { id: string; title: string; due: string | null; notes: string | null }[] }[]> {
    const lists = await this.call('tasks', 'LIST_TASK_LISTS', { maxResults: 20 });
    const rows: any[] = lists?.response_data?.items || lists?.items || [];
    const out: any[] = [];
    for (const l of rows.slice(0, 10)) {
      try {
        const t = await this.call('tasks', 'LIST_TASKS', { tasklist_id: l.id, showCompleted: false, maxResults: 50 });
        const items: any[] = t?.tasks || t?.items || t?.response_data?.items || [];
        out.push({
          listId: l.id,
          title: l.title || 'Tasks',
          tasks: items.filter((x) => x?.title).map((x) => ({ id: x.id, title: x.title, due: x.due || null, notes: x.notes || null })),
        });
      } catch {
        out.push({ listId: l.id, title: l.title || 'Tasks', tasks: [] });
      }
    }
    return out;
  }

  /** Mark a Google task complete (safe write). The patch action insists on the title, so it is looked up. */
  async taskComplete(listId: string, taskId: string): Promise<{ ok: boolean }> {
    const t = await this.call('tasks', 'LIST_TASKS', { tasklist_id: listId, showCompleted: false, maxResults: 100 });
    const items: any[] = t?.tasks || t?.items || t?.response_data?.items || [];
    const task = items.find((x) => x?.id === taskId);
    if (!task) throw new Error('That task could not be found — it may already be done.');
    await this.call('tasks', 'PATCH_TASK', { tasklist_id: listId, task_id: taskId, title: task.title || 'Task', status: 'completed' });
    return { ok: true };
  }

  // ---- Meet / Chat / Contacts ---------------------------------------------------------------

  async meetCreate(): Promise<{ uri: string | null; code: string | null }> {
    const d = await this.call('meet', 'CREATE_MEET', {});
    const r = d?.response_data || d || {};
    return { uri: r?.meetingUri || null, code: r?.meetingCode || null };
  }

  /** Google Chat spaces (rooms + direct messages) the user belongs to. */
  async chatSpaces(): Promise<{ spaces: { id: string; name: string; type: string }[]; available: boolean; note?: string }> {
    const d = await this.call('chat', 'LIST_SPACES', { page_size: 50 });
    const rows: any[] = d?.spaces || d?.response_data?.spaces || [];
    const spaces = rows.map((s) => ({
      id: s.name || '',
      name: s.displayName || (s.spaceType === 'DIRECT_MESSAGE' ? 'Direct message' : 'Untitled space'),
      type: s.spaceType || s.type || 'SPACE',
    }));
    return { spaces, available: true };
  }

  /** The user's Google Contacts (name + email + phone), read through the Gmail account's People access. */
  async contacts(): Promise<{ name: string; email: string | null; phone: string | null }[]> {
    const d = await this.call('contacts', 'GET_CONTACTS', { resource_name: 'people/me', person_fields: 'names,emailAddresses,phoneNumbers', include_other_contacts: true });
    const rows: any[] = d?.response_data?.connections || d?.connections || d?.response_data?.otherContacts || [];
    return rows
      .map((p) => ({
        name: p.names?.[0]?.displayName || p.emailAddresses?.[0]?.value || 'Unnamed contact',
        email: p.emailAddresses?.[0]?.value || null,
        phone: p.phoneNumbers?.[0]?.value || null,
      }))
      .filter((c) => c.name || c.email || c.phone);
  }

  // ---- the seam -----------------------------------------------------------------------------

  /**
   * Run one action for one of our Workspace services and hand back its `data`.
   *
   * Throws `Error('not-connected:<toolkit>')` when that service has no working account at `/tools`
   * — the controller turns it into a sentence that says which one to connect. Every other failure throws
   * the provider's own reason. Every attempt is written to `ToolCall`, success or not, including
   * the ones that never reach the provider — there are no quiet calls (BEA-1399): Composio counts
   * every one, so the owner's log must too. A Gmail call past today's cap is refused here, written
   * down as `gmail-cap`, and throws `gmail-cap:<calls>:<cap>`.
   */
  async call(service: string, action: string, args: Record<string, any>, opts: { timeoutMs?: number } = {}): Promise<any> {
    const toolkit = TOOLKIT[service] || service;
    const actionId = serviceToolId(toolkit, action);
    const account = await this.account(service);
    if (!account) {
      // Written down like every other attempt, including the ones that never leave the building.
      await this.record({ actionId, service: toolkit, args, ok: false, ms: 0, error: 'not-connected' });
      throw new Error(`not-connected:${toolkit}`);
    }
    if (toolkit === 'gmail') {
      try {
        await this.assertUnderGmailCap();
      } catch (e: any) {
        await this.record({ actionId, service: toolkit, accountId: account.id, args, ok: false, ms: 0, error: CAP_ERROR });
        throw e;
      }
    }
    const started = Date.now();
    const p: ServiceProvider = this.provider as any;
    const res: ExecuteResult = await p
      .execute(actionId, args, { connectionId: account.id, timeoutMs: opts.timeoutMs })
      .catch((e: any): ExecuteResult => ({ ok: false, error: String(e?.message || e) }));
    const ms = res?.ms ?? Date.now() - started;
    await this.record({ actionId, service: toolkit, accountId: account.id, args, ok: !!res?.ok, ms, error: res?.ok ? undefined : res?.error, data: res?.data });
    if (!res?.ok) throw new Error(this.plainReason(res?.error, service));
    return res.data;
  }

  /** The working account for one of our services, or null. `contacts` and `forms` ride on Gmail and Drive. */
  private async account(service: string): Promise<ServiceAccount | null> {
    const toolkit = TOOLKIT[service] || service;
    try {
      const info = await this.provider.getService(toolkit);
      const active = (info?.accounts || []).filter((a) => String(a.status || '').toUpperCase() === 'ACTIVE');
      return active[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch staged bytes from the short-lived link the provider hands back for binary content, with
   * the same 40 MB ceiling the bridge had. Never a JSON body — this is the file itself.
   */
  private async bytesFrom(url: string): Promise<Buffer> {
    if (!/^https:\/\//i.test(url)) throw new Error('Could not download that file from Google.');
    const r = await fetch(url, { signal: AbortSignal.timeout(BINARY_TIMEOUT_MS) });
    if (!r.ok) throw new Error('Could not download that file from Google.');
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > MAX_BYTES) throw new Error('That file is too big to bring in.');
    // Read in pieces and stop at the cap — the declared length is the staging host's word, not ours,
    // and an oversized file must never be buffered whole before it is refused.
    if (!r.body) {
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error('That file is too big to bring in.');
      return buf;
    }
    const reader = (r.body as any).getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('That file is too big to bring in.');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  /** The `ToolCall` row — the same flight recorder every outside call writes to. Never throws. */
  private async record(call: { actionId: string; service: string; accountId?: string; args: any; ok: boolean; ms: number; error?: string; data?: any }): Promise<void> {
    try {
      await this.prisma?.toolCall?.create?.({
        data: {
          runId: null,
          runKind: 'google',
          service: call.service,
          action: call.actionId,
          accountId: call.accountId || null,
          arguments: JSON.stringify(call.args || {}).slice(0, 2000),
          result: call.ok ? this.summarise(call.data) : null,
          ok: call.ok,
          error: call.error ? String(call.error).slice(0, 500) : null,
          ms: Number.isFinite(call.ms) ? Math.round(call.ms) : null,
          gated: false,
        },
      });
    } catch (e: any) {
      this.logger.warn(`could not write the ToolCall row for ${call.actionId}: ${e?.message || e}`);
    }
  }

  /**
   * A short account of what came back — counts, never the payload (a thread can be 300 KB).
   *
   * BEA-1353: this must NEVER fall back to the raw response. A single-message fetch has no list key,
   * and its top level is the subject, the sender and the body preview; an attachment or Drive
   * download is a signed URL for the bytes. Both were being written into the log verbatim. When
   * nothing countable is found, describe the SHAPE — which keys, roughly how big — and nothing else.
   */
  private summarise(data: any): string {
    if (data === undefined || data === null) return 'Nothing was returned.';
    try {
      const counts: string[] = [];
      for (const k of ['messages', 'files', 'items', 'connections', 'spaces', 'tasks']) {
        const v = data?.[k] ?? data?.response_data?.[k];
        if (Array.isArray(v)) counts.push(`${v.length} ${k}`);
      }
      if (counts.length) return counts.join(', ');
      if (Array.isArray(data)) return `${data.length} items`;
      if (typeof data === 'object') {
        // Only the KEY NAMES at the top level, never a value — a key like "s3url" is safe to name,
        // the URL under it is not.
        const keys = Object.keys(data).filter((k) => /^[a-z0-9_]+$/i.test(k)).slice(0, 8);
        const size = safeSize(data);
        return `ok · ${keys.length ? keys.join(', ') : 'object'}${size ? ` · ~${size}` : ''}`;
      }
      return `ok · ${typeof data}`;
    } catch {
      return 'ok';
    }
  }

  /** The service's real reason in a sentence, never a payload. */
  private plainReason(error: any, service: string): string {
    const raw = String(error || '').trim() || `Google ${service} refused that call.`;
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        const body = JSON.parse(raw.slice(start, end + 1));
        const msg = body?.message || body?.error?.message || body?.error || body?.detail;
        if (msg) return String(msg).slice(0, 300);
      } catch {
        /* not JSON — fall through */
      }
    }
    return raw.slice(0, 300);
  }
}
