import { Injectable, Logger } from '@nestjs/common';
import { ItemsService } from '../items/items.service';

const BASE = process.env.GWS_RUNNER_URL || 'http://172.18.0.1:8766';

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
}
