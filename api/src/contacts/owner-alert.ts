/**
 * The ONE way My Brain messages its OWNER on WhatsApp (BEA-1362).
 *
 * WhatsApp delivers free text only inside the 24-hour window after the owner last wrote to the
 * number. Outside it Meta fails the message a few seconds after Postbox has already answered
 * `sent` — so a "send text, fall back to a template if it fails" order can never work: the failure
 * arrives too late to see. Every owner-bound message therefore goes out as the approved
 * `mybrain_update_v1` template FIRST — templates deliver any time — and the template's own
 * synchronous verdict is the truth we report. Free text may follow it as an optional second
 * message for a long body; it is never the only message.
 *
 * The template (UTILITY, en, approved 2026-08-17):
 *   Hi {{1}}, an update from My Brain 🤖 / {{2}} / {{3}} / Tap the button below to open it…
 *   URL button "Open in My Brain" = https://mybrain.1site.ai/ + a per-send suffix.
 * 1 = the owner's first name · 2 = one-line headline · 3 = one or two lines of detail.
 * Meta refuses a variable holding a newline (and 4+ spaces in a row) — `flat()` folds them to " · ".
 */

/** The template's name — one place, env-overridable so a v2 needs no code change. */
export const OWNER_TEMPLATE = process.env.POSTBOX_OWNER_TEMPLATE || 'mybrain_update_v1';
/** Its language — its own setting, so a change to the contact-reminder language never touches it. */
export const OWNER_TEMPLATE_LANG = process.env.POSTBOX_OWNER_LANG || 'en';
export const APP_URL = 'https://mybrain.1site.ai';
export const HEADLINE_MAX = 200;
export const DETAIL_MAX = 600;
export const OWNER_DEFAULT_NAME = 'Sandy';
export const NOT_APPROVED_NOTE = 'template not approved yet — free text may not deliver outside 24h';

export type SendVerdict = { wamid?: string | null; status?: string; error?: string | null };

/** The two Postbox calls this needs — the real `PostboxService` and every spec stub satisfy it. */
export type OwnerAlertSender = {
  isConfigured?: () => boolean;
  sendTemplate: (to: string, name: string, variables: string[], opts?: { language?: string; buttonUrl?: string }) => Promise<SendVerdict>;
  sendText: (to: string, body: string) => Promise<SendVerdict>;
};

export type OwnerAlertMessage = {
  /** Owner's first name → {{1}}. */
  firstName?: string;
  /** One line: which agent/alert and what happened → {{2}}. */
  headline: string;
  /** One or two lines, may hold the result link → {{3}}. */
  detail?: string;
  /** App path the button opens, e.g. `/agent/runs/<id>` (leading slash optional). */
  path?: string;
  /** A long body to send as a SECOND, free-text message after the template (best effort). */
  longBody?: string;
};

export type OwnerAlertResult = {
  /** True only when Postbox accepted the message that went out (template, or free text when the template is unusable). */
  sent: boolean;
  /** Which message carried it. */
  via?: 'template' | 'text';
  wamid?: string | null;
  /** Postbox's / Meta's reason when it failed. */
  error?: string | null;
  /** A caveat worth showing even on success — today only `NOT_APPROVED_NOTE`. */
  note?: string;
  /** What happened to the optional free-text follow-up, when one was attempted. */
  followUp?: 'sent' | 'failed';
};

/**
 * The owner's first name for "Hi {{1}}" — a Setting when one exists (`owner.name` / `owner.firstName`),
 * else the default. Shared by every road so the greeting can never differ between them.
 */
export async function ownerFirstName(prisma: { setting?: { findUnique?: (a: any) => Promise<any> } } | null | undefined): Promise<string> {
  for (const key of ['owner.name', 'owner.firstName']) {
    const v = await prisma?.setting?.findUnique?.({ where: { key } })?.catch?.(() => null);
    const first = String(v?.value || '').trim().split(/\s+/)[0];
    if (first) return first;
  }
  return OWNER_DEFAULT_NAME;
}

/** One line, no newlines/tabs, single spaces, cut to `max` — what a template variable may hold. */
export function flat(s: unknown, max: number): string {
  const t = String(s ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/(?:\s*·\s*){2,}/g, ' · ')
    .trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1)).trimEnd()}…` : t;
}

/** The URL-button suffix: the app path without its leading slash. */
export function buttonSuffix(path?: string): string {
  const p = String(path || '').trim().replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
  return p || '';
}

/** Postbox/Meta said the TEMPLATE itself is unusable (not approved / unknown), not this send. */
export function templateUnusable(error?: string | null): boolean {
  const e = String(error || '');
  return /not approved|isn't approved|is not approved|not yet approved|does not exist|doesn't exist|no template|template.*not found|unknown template|132001/i.test(e);
}

/** The plain-text twin of the template, for the not-approved fallback. */
export function ownerAlertText(msg: OwnerAlertMessage): string {
  const link = msg.path ? `\n\nOpen: ${APP_URL}/${buttonSuffix(msg.path)}` : '';
  return `🤖 ${flat(msg.headline, HEADLINE_MAX)}${msg.detail ? `\n${String(msg.detail).trim()}` : ''}${link}`.trim();
}

/**
 * Template first, then (only if it is long) the free-text body as a second message. Never text
 * alone — except when Postbox says the template is not approved, and then the result SAYS so.
 */
export async function sendOwnerAlert(postbox: OwnerAlertSender, to: string, msg: OwnerAlertMessage): Promise<OwnerAlertResult> {
  if (postbox.isConfigured && !postbox.isConfigured()) return { sent: false, error: 'Postbox not configured.' };
  const firstName = flat(msg.firstName || OWNER_DEFAULT_NAME, 40) || OWNER_DEFAULT_NAME;
  const headline = flat(msg.headline, HEADLINE_MAX) || 'An update is ready.';
  const detail = flat(msg.detail, DETAIL_MAX) || 'Open My Brain for the details.';
  const suffix = buttonSuffix(msg.path);
  const t = await postbox.sendTemplate(to, OWNER_TEMPLATE, [firstName, headline, detail], { language: OWNER_TEMPLATE_LANG, ...(suffix ? { buttonUrl: suffix } : {}) }).catch((e: any) => ({ status: 'failed', error: String(e?.message || e) }) as SendVerdict);

  if (t?.status !== 'failed') {
    const out: OwnerAlertResult = { sent: true, via: 'template', wamid: t?.wamid ?? null };
    // The optional second message: only when the body says more than the template could carry.
    const long = String(msg.longBody || '').trim();
    if (long && long.length > flat(long, DETAIL_MAX).length) {
      const x = await postbox.sendText(to, long.slice(0, 3900)).catch((e: any) => ({ status: 'failed', error: String(e?.message || e) }) as SendVerdict);
      out.followUp = x?.status === 'failed' ? 'failed' : 'sent';
    }
    return out;
  }

  if (templateUnusable(t?.error)) {
    // The template is not (yet) approved: free text is the only road left, and it may not deliver.
    const x = await postbox.sendText(to, msg.longBody?.trim() || ownerAlertText(msg)).catch((e: any) => ({ status: 'failed', error: String(e?.message || e) }) as SendVerdict);
    if (x?.status === 'failed') return { sent: false, via: 'text', wamid: null, error: x?.error || t?.error || 'send failed', note: NOT_APPROVED_NOTE };
    return { sent: true, via: 'text', wamid: x?.wamid ?? null, note: NOT_APPROVED_NOTE };
  }

  return { sent: false, via: 'template', wamid: null, error: t?.error || 'WhatsApp refused the message.' };
}

/**
 * The honest step line for a run — one wording everywhere. `null`/`undefined` = the alerts service
 * is not wired on this server; `why` carries the settings answers ("no number", "off", …).
 */
export function whatsappStepLabel(r: (Partial<OwnerAlertResult> & { why?: string }) | null | undefined): { label: string; status: 'done' | 'info' } {
  if (!r) return { label: '⚠️ Not sent to WhatsApp — WhatsApp is not available on this server', status: 'info' };
  if (r.sent) {
    if (r.via === 'text') return { label: `WhatsApp sent (free text) — ${r.note || NOT_APPROVED_NOTE}`, status: 'done' };
    const tail = r.followUp === 'failed' ? ' — the longer follow-up text did not go through' : '';
    return { label: `WhatsApp sent (template)${tail}`, status: 'done' };
  }
  switch (r.why) {
    case 'no number': return { label: '⚠️ Not sent to WhatsApp — no WhatsApp number in Settings (Settings → Agent Engine)', status: 'info' };
    case 'off': return { label: '⚠️ Not sent to WhatsApp — the WhatsApp outputs switch is off in Settings', status: 'info' };
    case 'postbox not configured': return { label: '⚠️ Not sent to WhatsApp — WhatsApp (Postbox) is not set up on this server', status: 'info' };
    case 'cooldown': return { label: '⚠️ Not sent to WhatsApp — a message about this went out less than 30 minutes ago', status: 'info' };
  }
  const reason = r.error || r.why || 'the message could not be delivered';
  const note = r.note ? ` (${r.note})` : '';
  return { label: `⚠️ WhatsApp failed: ${reason}${note}`, status: 'info' };
}
