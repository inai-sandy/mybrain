import { Injectable, Logger } from '@nestjs/common';
import { ItemsService } from '../items/items.service';

const BASE = process.env.GWS_RUNNER_URL || 'http://172.18.0.1:8766';

// All Workspace services we surface, and the scope prefixes that mean "this service is on".
const SERVICE_MAP: { key: string; label: string; match: string[]; unsupported?: boolean }[] = [
  { key: 'gmail', label: 'Gmail', match: ['gmail'] },
  { key: 'drive', label: 'Drive', match: ['drive'] },
  { key: 'docs', label: 'Docs', match: ['documents'] },
  { key: 'sheets', label: 'Sheets', match: ['spreadsheets'] },
  { key: 'slides', label: 'Slides', match: ['presentations'] },
  { key: 'calendar', label: 'Calendar', match: ['calendar'] },
  { key: 'tasks', label: 'Tasks', match: ['tasks'] },
  { key: 'forms', label: 'Forms', match: ['forms'] },
  { key: 'meet', label: 'Meet', match: ['meetings.space'] },
  { key: 'chat', label: 'Chat', match: ['chat'] },
  { key: 'contacts', label: 'Contacts', match: ['contacts', 'directory'] },
  { key: 'keep', label: 'Keep', match: ['keep'], unsupported: true },
];

/** Add n days to a YYYY-MM-DD key (n can be negative). */
function dayAdd(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function headerMap(payload: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload?.headers || []) if (h?.name) out[String(h.name).toLowerCase()] = h.value;
  return out;
}

/** Decode a base64url Gmail body part. */
function b64url(data?: string): string {
  if (!data) return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Remove quoted reply history so each message keeps only its NEW content (Gmail + Outlook styles). */
function stripQuoted(body: string): string {
  if (!body) return '';
  const norm = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = norm.split('\n');
  const isCut = (raw: string) => {
    const t = raw.trim();
    return (
      /^On\b.{0,200}\bwrote:?$/i.test(t) || // Gmail "On <date>, <name> wrote:"
      /^_{5,}$/.test(t) || // Outlook "________________"
      /^-{2,}\s*Original Message\s*-{2,}/i.test(t) ||
      /^-{2,}\s*Forwarded message\s*-{2,}/i.test(t) ||
      /^From:\s.+\S+@\S+/i.test(t) || // Outlook quote header "From: name <email>"
      /^>{1,}/.test(t) // ">"-quoted line
    );
  };
  const out: string[] = [];
  for (const ln of lines) {
    if (isCut(ln)) break;
    out.push(ln);
  }
  let res = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Top-posted reply where everything got cut? fall back to a trimmed original so we never lose content.
  if (res.length < 30) res = norm.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
  return res;
}

/** Walk a Gmail payload tree for the best text body (prefer text/plain, fall back to stripped html). */
function extractBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64url(payload.body.data);
  for (const part of payload.parts || []) {
    const t = extractBody(part);
    if (t) return t;
  }
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return b64url(payload.body.data).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  }
  return '';
}

/** Talks to the host `gws-runner` bridge, which drives the Google Workspace CLI (`gws`).
 *  The CLI holds the user's Google login; the app never sees OAuth tokens directly. */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);

  constructor(private readonly items: ItemsService) {}

  /** Connection state — offline-safe (bridge down / not authed → connected:false, never throws). */
  async status(): Promise<{ connected: boolean; email: string | null; gws: boolean; bridge: boolean }> {
    try {
      const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return { connected: false, email: null, gws: false, bridge: false };
      const d: any = await r.json();
      return { connected: !!d.connected, email: d.email || null, gws: !!d.installed, bridge: true };
    } catch {
      return { connected: false, email: null, gws: false, bridge: false };
    }
  }

  /** Per-service status + access level (Read & write / Read-only / Off), derived from the granted scopes. */
  async services(): Promise<{ connected: boolean; email: string | null; project: string | null; services: { key: string; label: string; access: string; enabled: boolean; unsupported: boolean }[] }> {
    let raw: any = {};
    let connected = false;
    let email: string | null = null;
    try {
      const r = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const d: any = await r.json();
        raw = d.raw || {};
        connected = !!d.connected;
        email = d.email || raw.user || null;
      }
    } catch {
      /* offline — return all off */
    }
    const granted: string[] = Array.isArray(raw.scopes) ? raw.scopes.map((s: string) => String(s).replace(/^https:\/\/www\.googleapis\.com\/auth\//, '')) : [];
    const services = SERVICE_MAP.map((svc) => {
      const matched = granted.filter((g) => svc.match.some((m) => g === m || g.startsWith(`${m}.`) || g.startsWith(m)));
      let access = 'off';
      if (matched.length) access = matched.some((g) => !g.endsWith('.readonly')) ? 'read-write' : 'read-only';
      return { key: svc.key, label: svc.label, access, enabled: access !== 'off', unsupported: !!svc.unsupported };
    });
    return { connected, email, project: raw.project_id || null, services };
  }

  /** Run a gws command via the bridge and return its parsed JSON.
   *  Throws Error('not-connected') when gws has no Google login (exit code 2),
   *  Error('bridge-down') when the host bridge is unreachable. */
  async run(argv: string[]): Promise<any> {
    let d: any;
    try {
      const r = await fetch(`${BASE}/gws`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ argv }),
        signal: AbortSignal.timeout(60000),
      });
      d = await r.json();
    } catch (e) {
      this.logger.warn(`gws bridge unreachable: ${String((e as Error)?.message || e)}`);
      throw new Error('bridge-down');
    }
    if (!d.ok) {
      if (d.code === 2) throw new Error('not-connected');
      const apiMsg = d?.json?.error?.message;
      const stderrLine = String(d.stderr || '')
        .split('\n')
        .map((s) => s.replace(/^error\[[^\]]*\]:\s*/, '').trim())
        .filter((s) => s && !/^Using keyring backend/i.test(s))[0];
      throw new Error(apiMsg || stderrLine || 'gws command failed');
    }
    return d.json ?? d.text;
  }

  // ---- Gmail ----

  /** Recent (optionally searched) messages with From/Subject/Date/snippet. */
  async gmailList(q?: string): Promise<{ id: string; from: string; subject: string; date: string; snippet: string }[]> {
    const params = JSON.stringify({ userId: 'me', maxResults: 15, ...(q?.trim() ? { q: q.trim() } : {}) });
    const list = await this.run(['gmail', 'users', 'messages', 'list', '--params', params, '--format', 'json']);
    const ids: string[] = ((list?.messages as any[]) || []).map((m) => m.id).filter(Boolean).slice(0, 15);
    const metas = await Promise.all(
      ids.map(async (id) => {
        try {
          const p = JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
          const m = await this.run(['gmail', 'users', 'messages', 'get', '--params', p, '--format', 'json']);
          const h = headerMap(m?.payload);
          return { id, from: h.from || '', subject: h.subject || '(no subject)', date: h.date || '', snippet: m?.snippet || '' };
        } catch {
          return null;
        }
      }),
    );
    return metas.filter(Boolean) as any[];
  }

  /** Unread inbox messages received on a specific local day (cheap — uses resultSizeEstimate). */
  async gmailDayUnread(day: string): Promise<number | null> {
    const next = dayAdd(day, 1);
    const q = `is:unread after:${day.replace(/-/g, '/')} before:${next.replace(/-/g, '/')}`;
    const params = JSON.stringify({ userId: 'me', q, maxResults: 1 });
    const r = await this.run(['gmail', 'users', 'messages', 'list', '--params', params, '--format', 'json']);
    const n = Number(r?.resultSizeEstimate);
    return Number.isFinite(n) ? n : null;
  }

  /** The "important" emails received on a local day — Promotions/Social/Updates + Chats excluded. */
  async gmailImportantForDay(day: string, max = 25): Promise<{ id: string; threadId: string; from: string; subject: string; date: string; snippet: string }[]> {
    const next = dayAdd(day, 1);
    const q = `after:${day.replace(/-/g, '/')} before:${next.replace(/-/g, '/')} -category:promotions -category:social -category:updates -in:chats`;
    const params = JSON.stringify({ userId: 'me', q, maxResults: max });
    const list = await this.run(['gmail', 'users', 'messages', 'list', '--params', params, '--format', 'json']);
    const ids: string[] = ((list?.messages as any[]) || []).map((m) => m.id).filter(Boolean).slice(0, max);
    const metas = await Promise.all(
      ids.map(async (id) => {
        try {
          const p = JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
          const m = await this.run(['gmail', 'users', 'messages', 'get', '--params', p, '--format', 'json']);
          const h = headerMap(m?.payload);
          return { id, threadId: m?.threadId || id, from: h.from || '', subject: h.subject || '(no subject)', date: h.date || '', snippet: m?.snippet || '' };
        } catch {
          return null;
        }
      }),
    );
    return metas.filter(Boolean) as any[];
  }

  /** Import one email into Capture (searchable + chat-able). */
  async gmailImport(id: string): Promise<{ id: string; title: string }> {
    const p = JSON.stringify({ userId: 'me', id, format: 'full' });
    const m = await this.run(['gmail', 'users', 'messages', 'get', '--params', p, '--format', 'json']);
    const h = headerMap(m?.payload);
    const subject = h.subject || '(no subject)';
    const body = extractBody(m?.payload) || m?.snippet || '';
    const text = `From: ${h.from || ''}\nDate: ${h.date || ''}\nSubject: ${subject}\n\n${body}`.trim();
    const { item } = await this.items.store(text, 'gmail', subject, undefined, ['email']);
    return { id: item.id, title: item.title };
  }

  /** Search Gmail and return up to `max` distinct matching threads (newest message per thread). */
  async gmailSearchThreads(query: string, max = 5): Promise<{ threadId: string; subject: string; from: string; date: string; snippet: string }[]> {
    const params = JSON.stringify({ userId: 'me', q: query, maxResults: 20 });
    const list = await this.run(['gmail', 'users', 'messages', 'list', '--params', params, '--format', 'json']);
    const ids: string[] = ((list?.messages as any[]) || []).map((m) => m.id).filter(Boolean).slice(0, 20);
    const seen = new Set<string>();
    const out: { threadId: string; subject: string; from: string; date: string; snippet: string }[] = [];
    for (const id of ids) {
      if (out.length >= max) break;
      try {
        const p = JSON.stringify({ userId: 'me', id, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
        const m = await this.run(['gmail', 'users', 'messages', 'get', '--params', p, '--format', 'json']);
        const tid = m?.threadId || id;
        if (seen.has(tid)) continue;
        seen.add(tid);
        const h = headerMap(m?.payload);
        out.push({ threadId: tid, subject: h.subject || '(no subject)', from: h.from || '', date: h.date || '', snippet: m?.snippet || '' });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  /** Fetch a whole Gmail thread as readable text (subject + each message's from/date/body). */
  async gmailThread(threadId: string): Promise<{ subject: string; copy: string; messages: { from: string; date: string; body: string }[] }> {
    const p = JSON.stringify({ userId: 'me', id: threadId, format: 'full' });
    const t = await this.run(['gmail', 'users', 'threads', 'get', '--params', p, '--format', 'json']);
    const messages = ((t?.messages as any[]) || []).map((m) => {
      const h = headerMap(m?.payload);
      const raw = extractBody(m?.payload) || m?.snippet || '';
      return { from: h.from || '', date: h.date || '', subject: h.subject || '', body: stripQuoted(raw).slice(0, 6000) };
    });
    const subject = messages.find((m) => m.subject)?.subject || '(no subject)';
    const copy = messages.map((m, i) => `--- Message ${i + 1} of ${messages.length} ---\nFrom: ${m.from}\nDate: ${m.date}\n\n${m.body}`).join('\n\n');
    return { subject, copy, messages };
  }

  /** Full plain-text body of ONE message (de-quoted, capped). For storing important emails in memory. (BEA-439) */
  async gmailMessageFull(id: string): Promise<string> {
    const p = JSON.stringify({ userId: 'me', id, format: 'full' });
    const m = await this.run(['gmail', 'users', 'messages', 'get', '--params', p, '--format', 'json']);
    const raw = extractBody(m?.payload) || m?.snippet || '';
    return stripQuoted(raw).slice(0, 20000);
  }

  // ---- Drive / Docs / Sheets ----

  async driveList(q?: string): Promise<{ id: string; name: string; mimeType: string; modified: string; link: string }[]> {
    const query = q?.trim() ? `name contains '${q.trim().replace(/'/g, "\\'")}' and trashed=false` : 'trashed=false';
    const params = JSON.stringify({ q: query, pageSize: 20, orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,webViewLink)' });
    const r = await this.run(['drive', 'files', 'list', '--params', params, '--format', 'json']);
    return ((r?.files as any[]) || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modified: f.modifiedTime, link: f.webViewLink }));
  }

  /** Import a Drive file's text into Capture. Google Docs/Sheets/Slides are exported; text files downloaded. */
  async driveImport(id: string): Promise<{ id: string; title: string }> {
    const meta = await this.run(['drive', 'files', 'get', '--params', JSON.stringify({ fileId: id, fields: 'id,name,mimeType,webViewLink' }), '--format', 'json']);
    const name = meta?.name || 'Drive file';
    const mt = String(meta?.mimeType || '');
    const exportMap: Record<string, string> = {
      'application/vnd.google-apps.document': 'text/plain',
      'application/vnd.google-apps.spreadsheet': 'text/csv',
      'application/vnd.google-apps.presentation': 'text/plain',
    };
    let content = '';
    if (exportMap[mt]) {
      content = String((await this.run(['drive', 'files', 'export', '--params', JSON.stringify({ fileId: id, mimeType: exportMap[mt] })])) || '');
    } else if (mt.startsWith('text/')) {
      content = String((await this.run(['drive', 'files', 'get', '--params', JSON.stringify({ fileId: id, alt: 'media' })])) || '');
    } else {
      throw new Error(`Can’t import a “${mt || 'file of this type'}” yet — only Google Docs/Sheets/Slides and text files.`);
    }
    if (!content.trim()) throw new Error('That file appears to be empty.');
    const { item } = await this.items.store(content, 'gdrive', name, meta?.webViewLink || undefined, ['drive']);
    return { id: item.id, title: item.title };
  }

  /** Create a NEW Google Doc with the given text (safe write — never edits existing files). */
  async docCreate(title: string, content: string): Promise<{ id: string; link: string }> {
    const doc = await this.run(['docs', 'documents', 'create', '--json', JSON.stringify({ title: (title || 'Untitled').slice(0, 200) }), '--format', 'json']);
    const docId = doc?.documentId;
    if (!docId) throw new Error('Could not create the document.');
    if (content?.trim()) {
      const body = JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: content.slice(0, 100000) } }] });
      await this.run(['docs', 'documents', 'batchUpdate', '--params', JSON.stringify({ documentId: docId }), '--json', body, '--format', 'json']);
    }
    return { id: docId, link: `https://docs.google.com/document/d/${docId}/edit` };
  }

  // ---- Calendar ----

  async calendar(): Promise<{ id: string; summary: string; start: string | null; end: string | null; location: string | null; link: string | null }[]> {
    const now = new Date().toISOString();
    const params = JSON.stringify({ calendarId: 'primary', maxResults: 12, timeMin: now, singleEvents: true, orderBy: 'startTime' });
    const r = await this.run(['calendar', 'events', 'list', '--params', params, '--format', 'json']);
    return ((r?.items as any[]) || []).map((e) => ({
      id: e.id,
      summary: e.summary || '(no title)',
      start: e.start?.dateTime || e.start?.date || null,
      end: e.end?.dateTime || e.end?.date || null,
      location: e.location || null,
      link: e.htmlLink || null,
    }));
  }

  // ---- Live hints for the launcher grid (cheap, best-effort) ----

  /** Small glance-able numbers for the Google tile grid. Never throws — missing bits come back null. */
  async hints(): Promise<{ connected: boolean; gmailUnread: number | null; calendarNext: { summary: string; start: string | null } | null; tasksOpen: number | null }> {
    const st = await this.status();
    if (!st.connected) return { connected: false, gmailUnread: null, calendarNext: null, tasksOpen: null };
    const [gmailUnread, calendarNext, tasksOpen] = await Promise.all([
      this.gmailUnreadCount().catch(() => null),
      this.calendar().then((evs) => (evs[0] ? { summary: evs[0].summary, start: evs[0].start } : null)).catch(() => null),
      this.tasks().then((lists) => lists.reduce((n, l) => n + l.tasks.length, 0)).catch(() => null),
    ]);
    return { connected: true, gmailUnread, calendarNext, tasksOpen };
  }

  /** Count of unread inbox messages (uses Gmail's resultSizeEstimate — one cheap call). */
  async gmailUnreadCount(): Promise<number | null> {
    const params = JSON.stringify({ userId: 'me', q: 'is:unread in:inbox', maxResults: 1 });
    const r = await this.run(['gmail', 'users', 'messages', 'list', '--params', params, '--format', 'json']);
    const n = Number(r?.resultSizeEstimate);
    return Number.isFinite(n) ? n : null;
  }

  // ---- Google Tasks ----

  async tasks(): Promise<{ listId: string; title: string; tasks: { id: string; title: string; due: string | null; notes: string | null }[] }[]> {
    const lists = await this.run(['tasks', 'tasklists', 'list', '--format', 'json']);
    const out: any[] = [];
    for (const l of ((lists?.items as any[]) || []).slice(0, 10)) {
      try {
        const t = await this.run(['tasks', 'tasks', 'list', '--params', JSON.stringify({ tasklist: l.id, showCompleted: false, maxResults: 50 }), '--format', 'json']);
        out.push({
          listId: l.id,
          title: l.title || 'Tasks',
          tasks: ((t?.items as any[]) || []).filter((x) => x.title).map((x) => ({ id: x.id, title: x.title, due: x.due || null, notes: x.notes || null })),
        });
      } catch {
        out.push({ listId: l.id, title: l.title || 'Tasks', tasks: [] });
      }
    }
    return out;
  }

  /** Mark a Google task complete (safe write). */
  async taskComplete(listId: string, taskId: string): Promise<{ ok: boolean }> {
    await this.run(['tasks', 'tasks', 'patch', '--params', JSON.stringify({ tasklist: listId, task: taskId }), '--json', JSON.stringify({ status: 'completed' }), '--format', 'json']);
    return { ok: true };
  }

  // ---- Meet + Sheets + Slides (safe writes: create NEW only) ----

  async meetCreate(): Promise<{ uri: string | null; code: string | null }> {
    const r = await this.run(['meet', 'spaces', 'create', '--format', 'json']);
    return { uri: r?.meetingUri || null, code: r?.meetingCode || null };
  }

  async sheetCreate(title: string): Promise<{ id: string; link: string }> {
    const r = await this.run(['sheets', 'spreadsheets', 'create', '--json', JSON.stringify({ properties: { title: (title || 'Untitled').slice(0, 200) } }), '--format', 'json']);
    const id = r?.spreadsheetId;
    if (!id) throw new Error('Could not create the spreadsheet.');
    return { id, link: `https://docs.google.com/spreadsheets/d/${id}/edit` };
  }

  async slidesCreate(title: string): Promise<{ id: string; link: string }> {
    const r = await this.run(['slides', 'presentations', 'create', '--json', JSON.stringify({ title: (title || 'Untitled').slice(0, 200) }), '--format', 'json']);
    const id = r?.presentationId;
    if (!id) throw new Error('Could not create the presentation.');
    return { id, link: `https://docs.google.com/presentation/d/${id}/edit` };
  }

  // ---- Forms / Chat / Contacts (read-only listings) ----

  /** Google Forms owned/visible to the user (found via Drive by mime type). */
  async forms(): Promise<{ id: string; name: string; modified: string; link: string }[]> {
    const params = JSON.stringify({
      q: "mimeType='application/vnd.google-apps.form' and trashed=false",
      pageSize: 30,
      orderBy: 'modifiedTime desc',
      fields: 'files(id,name,modifiedTime,webViewLink)',
    });
    const r = await this.run(['drive', 'files', 'list', '--params', params, '--format', 'json']);
    return ((r?.files as any[]) || []).map((f) => ({
      id: f.id,
      name: f.name || 'Untitled form',
      modified: f.modifiedTime || '',
      link: f.webViewLink || `https://docs.google.com/forms/d/${f.id}/edit`,
    }));
  }

  /** Google Chat spaces (rooms + direct messages) the user belongs to.
   *  Chat needs a Chat app configured in Google Cloud; when that's absent the API 404s —
   *  we degrade to an informative, non-error empty state rather than failing the request. */
  async chatSpaces(): Promise<{ spaces: { id: string; name: string; type: string }[]; available: boolean; note?: string }> {
    try {
      const r = await this.run(['chat', 'spaces', 'list', '--params', JSON.stringify({ pageSize: 50 }), '--format', 'json']);
      const spaces = ((r?.spaces as any[]) || []).map((s) => ({
        id: s.name || '',
        name: s.displayName || (s.spaceType === 'DIRECT_MESSAGE' ? 'Direct message' : 'Untitled space'),
        type: s.spaceType || s.type || 'SPACE',
      }));
      return { spaces, available: true };
    } catch (e) {
      const m = String((e as Error)?.message || e);
      if (m === 'not-connected' || m === 'bridge-down') throw e;
      return { spaces: [], available: false, note: 'Google Chat needs a Chat app turned on in Google Cloud for this account before spaces can be listed.' };
    }
  }

  /** The user's Google Contacts (name + email + phone). */
  async contacts(): Promise<{ name: string; email: string | null; phone: string | null }[]> {
    const params = JSON.stringify({ resourceName: 'people/me', pageSize: 100, personFields: 'names,emailAddresses,phoneNumbers' });
    const r = await this.run(['people', 'people', 'connections', 'list', '--params', params, '--format', 'json']);
    return ((r?.connections as any[]) || [])
      .map((p) => ({
        name: p.names?.[0]?.displayName || p.emailAddresses?.[0]?.value || 'Unnamed contact',
        email: p.emailAddresses?.[0]?.value || null,
        phone: p.phoneNumbers?.[0]?.value || null,
      }))
      .filter((c) => c.name || c.email || c.phone);
  }
}
