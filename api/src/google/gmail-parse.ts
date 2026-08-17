/**
 * Reading a Gmail message payload — the pure functions, with no transport in them.
 *
 * The payload is Google's own `users.messages` shape (headers, mimeType, parts, body.data). It was
 * proven identical byte for byte whichever road it arrives by — the old gws bridge and the
 * ServiceProvider seam both hand back Google's own object (checked live on 2026-08-17 on a real
 * message and a real 8-message thread; only the per-fetch attachment ids differ, and Gmail rotates
 * those on every read). So the parsing lives here once, and the transport is somebody else's job.
 */

/** Add n days to a YYYY-MM-DD key (n can be negative). */
export function dayAdd(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function headerMap(payload: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload?.headers || []) if (h?.name) out[String(h.name).toLowerCase()] = h.value;
  return out;
}

/** Decode a base64url Gmail body part. */
export function b64url(data?: string): string {
  if (!data) return '';
  try {
    return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/** Remove quoted reply history so each message keeps only its NEW content (Gmail + Outlook styles). */
export function stripQuoted(body: string): string {
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
export function extractBody(payload: any): string {
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

/** A filename that is safe on disk and still recognisable — used for the email's own document. */
export function safeFilename(name: string): string {
  return (name || 'email')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'email';
}

export type GmailAttachmentRef = { filename: string; mimeType: string; attachmentId: string };

/**
 * Every real attachment in a Gmail payload tree. Inline images (a signature logo, a tracking pixel)
 * would otherwise flood the library, so they are left out. (BEA-1341)
 *
 * "Inline" is decided by Content-Disposition, NOT by the presence of a Content-ID: Outlook puts a
 * Content-ID on genuinely attached files too, so treating that as inline silently dropped real
 * attachments — the worst kind of failure here, because the count looks right and nothing errors.
 */
export function collectAttachments(payload: any, out: GmailAttachmentRef[] = []): GmailAttachmentRef[] {
  if (!payload) return out;
  const filename = String(payload.filename || '').trim();
  const attachmentId = payload.body?.attachmentId;
  const disposition = (payload.headers || []).find((x: any) => String(x?.name).toLowerCase() === 'content-disposition')?.value;
  const inline = /^\s*inline\b/i.test(String(disposition || ''));
  if (filename && attachmentId && !inline) {
    out.push({ filename, mimeType: String(payload.mimeType || 'application/octet-stream'), attachmentId });
  }
  for (const part of payload.parts || []) collectAttachments(part, out);
  return out;
}

/** The Gmail search for one local day's important mail — Promotions/Social/Updates + Chats excluded. */
export function importantDayQuery(day: string): string {
  const next = dayAdd(day, 1);
  return `after:${day.replace(/-/g, '/')} before:${next.replace(/-/g, '/')} -category:promotions -category:social -category:updates -in:chats`;
}

/** The Gmail search for one local day's unread mail. */
export function unreadDayQuery(day: string): string {
  const next = dayAdd(day, 1);
  return `is:unread after:${day.replace(/-/g, '/')} before:${next.replace(/-/g, '/')}`;
}
