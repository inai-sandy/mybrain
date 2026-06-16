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
      const msg = (d.stderr || '').split('\n')[0] || 'gws command failed';
      throw new Error(msg);
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
}
