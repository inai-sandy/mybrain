import { Injectable, Logger } from '@nestjs/common';

/**
 * The WhatsApp settings section's data (BEA-1114) — My Brain's OWN slice of the shared Postbox
 * gateway, read-only: the templates this app sends with (live approval status) and the messages
 * this app sent. Strictly scoped to the "My Brain" app — no team traffic, no other apps.
 */
@Injectable()
export class WhatsappService {
  private readonly log = new Logger('Whatsapp');
  private readonly base = (process.env.POSTBOX_URL || 'https://postbox.1site.ai/api').replace(/\/$/, '');
  private readonly token = process.env.POSTBOX_ADMIN_TOKEN || '';
  private appIdCache: string | null | undefined; // undefined = not resolved yet; null = not found

  configured(): boolean {
    return !!this.token;
  }

  /** The template names My Brain actually sends with — the section shows ONLY these. */
  usedTemplateNames(): string[] {
    return [
      process.env.POSTBOX_REMINDER_TEMPLATE || 'reminder_nudge_v3',
      process.env.POSTBOX_TASKLIST_TEMPLATE || 'task_list_v1',
    ];
  }

  private async admin(path: string): Promise<any> {
    const r = await fetch(`${this.base}${path}`, {
      headers: { 'x-postbox-token': this.token },
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`gateway ${r.status}`);
    return r.json();
  }

  /** My Brain's templates with their live Meta status; missing ones are shown honestly. */
  async templates(): Promise<{ configured: boolean; templates: any[] }> {
    if (!this.configured()) return { configured: false, templates: [] };
    try {
      const d = await this.admin('/admin/templates');
      const all: any[] = d?.templates || (Array.isArray(d) ? d : []);
      const used = this.usedTemplateNames();
      const templates = used.map((name) => {
        const t = all.find((x) => x?.name === name);
        if (!t) return { name, language: null, status: 'NOT_FOUND', category: null, warning: 'This template no longer exists on the WhatsApp account.' };
        const warning = t.category && t.category !== 'UTILITY'
          ? `Meta set this to ${t.category} — delivery rules differ; consider re-submitting as utility.`
          : t.status !== 'APPROVED'
            ? 'Not approved yet — sends fall back to plain text inside the 24h window.'
            : null;
        return { name: t.name, language: t.language || null, status: t.status || 'UNKNOWN', category: t.category || null, body: t.bodyText || null, warning };
      });
      return { configured: true, templates };
    } catch (e: any) {
      this.log.warn(`templates: ${e?.message}`);
      return { configured: true, templates: this.usedTemplateNames().map((name) => ({ name, status: 'UNREACHABLE', warning: 'Could not reach the WhatsApp gateway right now.' })) };
    }
  }

  /** The WhatsApp number(s) My Brain SENDS from — label match first, else the gateway default. */
  async numbers(): Promise<{ configured: boolean; numbers: any[] }> {
    if (!this.configured()) return { configured: false, numbers: [] };
    try {
      const all: any[] = await this.admin('/admin/numbers');
      const mine = all.filter((n) => /brain/i.test(String(n?.label || '')));
      const pick = mine.length ? mine : all.filter((n) => n?.isDefault);
      return {
        configured: true,
        numbers: pick.map((n) => ({ number: n.wanumber, label: n.label || null, isDefault: !!n.isDefault, messages: n.messages ?? null })),
      };
    } catch (e: any) {
      this.log.warn(`numbers: ${e?.message}`);
      return { configured: true, numbers: [] };
    }
  }

  /** Resolve My Brain's app id on the gateway (cached). */
  private async appId(): Promise<string | null> {
    if (this.appIdCache !== undefined) return this.appIdCache;
    try {
      const apps: any[] = await this.admin('/admin/apps');
      const hit = apps.find((a) => String(a?.name || '').trim().toLowerCase() === 'my brain')
        || apps.find((a) => /brain/i.test(String(a?.name || '')));
      this.appIdCache = hit?.id || null;
    } catch {
      return null; // don't cache a transient failure
    }
    return this.appIdCache;
  }

  /** Messages MY BRAIN sent (and their replies) — never other apps' traffic. */
  async messages(q: { query?: string; status?: string; page?: number; pageSize?: number }): Promise<{ configured: boolean; rows: any[]; total: number }> {
    if (!this.configured()) return { configured: false, rows: [], total: 0 };
    const appId = await this.appId();
    if (!appId) return { configured: true, rows: [], total: 0 };
    const params = new URLSearchParams({ appId, page: String(Math.max(1, q.page || 1)), pageSize: String(Math.min(50, Math.max(1, q.pageSize || 20))) });
    if (q.query?.trim()) params.set('query', q.query.trim().slice(0, 80));
    if (q.status?.trim()) params.set('status', q.status.trim());
    try {
      const d = await this.admin(`/admin/messages?${params.toString()}`);
      const rows = (d?.rows || []).map((r: any) => ({
        id: r.id,
        to: r.to,
        direction: r.direction,
        type: r.type,
        templateName: r.templateName || null,
        body: r.body ? String(r.body).slice(0, 260) : null,
        status: r.status,
        error: r.error || null,
        at: r.createdAt,
      }));
      return { configured: true, rows, total: d?.total ?? rows.length };
    } catch (e: any) {
      this.log.warn(`messages: ${e?.message}`);
      return { configured: true, rows: [], total: 0 };
    }
  }
}
