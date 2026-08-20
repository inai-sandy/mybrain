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
/**
 * The cleaner, strictly-transactional template (2 variables: name + one-line result, URL button
 * "Open result") — tried FIRST once Meta approves it; while it is pending, Postbox answers
 * "not approved" and the send falls through to `mybrain_update_v1` (BEA-1379).
 */
export const OWNER_RESULT_TEMPLATE = process.env.POSTBOX_OWNER_RESULT_TEMPLATE || 'mybrain_result_v1';
/** Its language — its own setting, so a change to the contact-reminder language never touches it. */
export const OWNER_TEMPLATE_LANG = process.env.POSTBOX_OWNER_LANG || 'en';
export const APP_URL = 'https://mybrain.1site.ai';
export const HEADLINE_MAX = 200;
export const DETAIL_MAX = 600;
export const OWNER_DEFAULT_NAME = 'Sandy';
export const NOT_APPROVED_NOTE = 'template not approved yet — free text may not deliver outside 24h';

export type SendVerdict = { wamid?: string | null; status?: string; error?: string | null; id?: string | null };

/**
 * How the delivery check paces itself — the ONE place these numbers live (BEA-1379). Meta's real
 * verdict (delivered / read / failed) lands on the Postbox row 2–7 seconds after a send that
 * Postbox already answered `sent` for — so we wait, ask once, and retry once while it still says
 * `sent`. Tests set `waitMs` to 0.
 */
export const VERDICT = { waitMs: 8_000, retries: 1 };

/** The honest step wording when Meta refused the template and Telegram carried the alert instead. */
export const REFUSED_ON_TELEGRAM = 'WhatsApp refused by Meta (engagement pacing) — sent on Telegram instead.';

/** The two Postbox calls this needs — the real `PostboxService` and every spec stub satisfy it. */
export type OwnerAlertSender = {
  isConfigured?: () => boolean;
  sendTemplate: (to: string, name: string, variables: string[], opts?: { language?: string; buttonUrl?: string }) => Promise<SendVerdict>;
  sendText: (to: string, body: string) => Promise<SendVerdict>;
  /** Meta's real verdict for a sent message (BEA-1379); `null` = the route could not be reached. */
  messageStatus?: (id: string) => Promise<{ status?: string; error?: string | null } | null>;
};

/**
 * The Telegram road for the refused-by-Meta fallback (BEA-1379). `TelegramService` registers
 * itself here at boot (the `setFlowSync` pattern — this file is plain functions, so the import
 * creates no module cycle and PushModule/ContactsModule never import TelegramModule).
 */
export type OwnerAlertTelegram = {
  notifyWhatsAppRefused?: (args: { headline: string; detail?: string; url?: string }) => Promise<{ sent: boolean; why?: string }>;
};
let defaultTelegram: OwnerAlertTelegram | null = null;
export function setOwnerAlertTelegram(t: OwnerAlertTelegram | null): void {
  defaultTelegram = t;
}

export type OwnerAlertOpts = {
  /** Overrides the registered Telegram road (tests); `null` = no Telegram on this server. */
  telegram?: OwnerAlertTelegram | null;
  /** True when this alert ALREADY went out on Telegram (a Watch/Alert push) — never send it twice. */
  telegramCarried?: boolean;
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
  /** True only when the alert reached a road that carried it (template, text, or the Telegram fallback). */
  sent: boolean;
  /** Which message carried it. `telegram` = Meta refused the template and Telegram carried the same alert (BEA-1379). */
  via?: 'template' | 'text' | 'telegram';
  wamid?: string | null;
  /** Postbox's / Meta's reason when it failed. */
  error?: string | null;
  /** A caveat worth showing even on success — today only `NOT_APPROVED_NOTE`. */
  note?: string;
  /** What happened to the optional free-text follow-up, when one was attempted. */
  followUp?: 'sent' | 'failed';
  /** Which template name Postbox accepted (the chain tries `mybrain_result_v1` then `mybrain_update_v1`). */
  template?: string;
  /** Meta's real verdict, when it was checked (BEA-1379). Absent = Meta said nothing within ~16 s. */
  delivery?: 'delivered' | 'refused' | 'unconfirmed';
  /** The Telegram leg after a refusal: sent | failed | already (the caller had already pushed it there). */
  telegram?: 'sent' | 'failed' | 'already';
  /** Why the Telegram leg failed, when it did. */
  telegramWhy?: string;
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

/**
 * Links stay OUT of the template variables. The first live send with a Google-Sheet URL inside
 * {{3}} was refused by Meta five seconds after Postbox accepted it ("This message was not delivered
 * to maintain healthy ecosystem engagement" — Meta reads a bare link in a UTILITY template as
 * marketing-like), while the same template without a link was delivered. The button already opens
 * the run/page in the app, and the app has the link — so the variables say so instead.
 */
export function withoutLinks(s: unknown): { text: string; hadLink: boolean } {
  const raw = String(s ?? '');
  const hadLink = /https?:\/\/\S+/i.test(raw);
  const text = raw
    .replace(/\s*(?:→|->|:|—|-)?\s*https?:\/\/\S+/gi, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return { text, hadLink };
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
 * The owner templates, tried in order (BEA-1379): the strictly-transactional `mybrain_result_v1`
 * first (2 variables: name + one-line result — the detail folds into the result line), then the
 * original `mybrain_update_v1` (3 variables). A Postbox answer of "not approved" / "does not
 * exist" for one name falls through to the next; any other verdict stops the chain.
 */
export function ownerTemplates(): { name: string; vars: (p: { firstName: string; headline: string; detail: string }) => string[] }[] {
  return [
    { name: OWNER_RESULT_TEMPLATE, vars: (p) => [p.firstName, flat([p.headline, p.detail].filter(Boolean).join(' · '), DETAIL_MAX)] },
    { name: OWNER_TEMPLATE, vars: (p) => [p.firstName, p.headline, p.detail] },
  ];
}

/**
 * Ask Postbox what Meta REALLY did with the message (BEA-1379): wait ~8 s, ask, retry once at
 * +8 s while the row still says `sent`. `null` = nothing to check (no id / old stub) or Meta said
 * nothing within the window — the synchronous verdict stands. `unconfirmed` = the status route
 * could not be reached, and the caller must SAY so rather than report a clean success.
 */
async function metaVerdict(postbox: OwnerAlertSender, id?: string | null): Promise<{ verdict: 'delivered' | 'refused' | 'unconfirmed'; error?: string | null } | null> {
  if (!id || typeof postbox.messageStatus !== 'function') return null;
  for (let i = 0; i <= VERDICT.retries; i++) {
    if (VERDICT.waitMs > 0) await new Promise((r) => setTimeout(r, VERDICT.waitMs));
    const s = await postbox.messageStatus(id).catch(() => null);
    if (!s?.status) return { verdict: 'unconfirmed' };
    if (s.status === 'failed') return { verdict: 'refused', error: s.error ?? null };
    if (s.status === 'delivered' || s.status === 'read') return { verdict: 'delivered' };
    // still `sent` → one more look
  }
  return null; // Meta raised no failure within ~16 s — nothing to correct
}

/**
 * Template first, then (only if it is long) the free-text body as a second message. Never text
 * alone — except when Postbox says the template is not approved, and then the result SAYS so.
 *
 * Since BEA-1379 the template's synchronous `sent` is no longer taken at face value: Meta's real
 * verdict is polled from Postbox, and a refusal ("This message was not delivered to maintain
 * healthy ecosystem engagement") sends the SAME alert on Telegram — said honestly on the result.
 * Never a silent success.
 */
export async function sendOwnerAlert(postbox: OwnerAlertSender, to: string, msg: OwnerAlertMessage, opts: OwnerAlertOpts = {}): Promise<OwnerAlertResult> {
  if (postbox.isConfigured && !postbox.isConfigured()) return { sent: false, error: 'Postbox not configured.' };
  const firstName = flat(msg.firstName || OWNER_DEFAULT_NAME, 40) || OWNER_DEFAULT_NAME;
  const h = withoutLinks(msg.headline);
  const d = withoutLinks(msg.detail);
  const headline = flat(h.text, HEADLINE_MAX) || 'An update is ready.';
  const linkNote = h.hadLink || d.hadLink ? 'The link is behind the button below.' : '';
  const detail = flat([d.text, linkNote].filter(Boolean).join(' · '), DETAIL_MAX) || 'Open My Brain for the details.';
  const suffix = buttonSuffix(msg.path);

  let t: SendVerdict | undefined;
  let used = '';
  for (const c of ownerTemplates()) {
    used = c.name;
    t = await postbox
      .sendTemplate(to, c.name, c.vars({ firstName, headline, detail }), { language: OWNER_TEMPLATE_LANG, ...(suffix ? { buttonUrl: suffix } : {}) })
      .catch((e: any) => ({ status: 'failed', error: String(e?.message || e) }) as SendVerdict);
    if (!(t?.status === 'failed' && templateUnusable(t?.error))) break; // accepted, or a real refusal — stop trying names
  }

  if (t?.status !== 'failed') {
    const out: OwnerAlertResult = { sent: true, via: 'template', wamid: t?.wamid ?? null, template: used };
    // The optional second message: only when the body says more than the template could carry.
    const long = String(msg.longBody || '').trim();
    if (long && long.length > flat(long, DETAIL_MAX).length) {
      const x = await postbox.sendText(to, long.slice(0, 3900)).catch((e: any) => ({ status: 'failed', error: String(e?.message || e) }) as SendVerdict);
      out.followUp = x?.status === 'failed' ? 'failed' : 'sent';
    }
    // Meta's real verdict (BEA-1379) — Postbox says `sent` before Meta decides.
    const v = await metaVerdict(postbox, t?.id);
    if (!v) return out;
    if (v.verdict !== 'refused') {
      out.delivery = v.verdict;
      return out;
    }
    // Refused after the accept. The owner heard nothing — Telegram carries the same alert.
    out.delivery = 'refused';
    out.error = v.error || 'This message was not delivered to maintain healthy ecosystem engagement';
    if (opts.telegramCarried) return { ...out, sent: false, telegram: 'already' };
    const tg = opts.telegram === undefined ? defaultTelegram : opts.telegram;
    const pushed = await tg?.notifyWhatsAppRefused?.({
      headline: flat(msg.headline, HEADLINE_MAX) || 'An update from My Brain',
      detail: String(msg.longBody || msg.detail || '').trim() || undefined,
      url: `${APP_URL}/${suffix}`,
    })?.catch?.((e: any) => ({ sent: false, why: String(e?.message || e) }));
    if (pushed?.sent) return { ...out, sent: true, via: 'telegram', telegram: 'sent' };
    return { ...out, sent: false, telegram: 'failed', telegramWhy: pushed?.why || 'Telegram is not set up on this server' };
  }

  if (templateUnusable(t?.error)) {
    // No usable template at all: free text is the only road left, and it may not deliver.
    const x = await postbox.sendText(to, msg.longBody?.trim() || ownerAlertText(msg)).catch((e: any) => ({ status: 'failed', error: String(e?.message || e) }) as SendVerdict);
    if (x?.status === 'failed') return { sent: false, via: 'text', wamid: null, error: x?.error || t?.error || 'send failed', note: NOT_APPROVED_NOTE };
    return { sent: true, via: 'text', wamid: x?.wamid ?? null, note: NOT_APPROVED_NOTE };
  }

  return { sent: false, via: 'template', wamid: null, error: t?.error || 'WhatsApp refused the message.', template: used };
}

/**
 * The honest step line for a run — one wording everywhere. `null`/`undefined` = the alerts service
 * is not wired on this server; `why` carries the settings answers ("no number", "off", …).
 */
export function whatsappStepLabel(r: (Partial<OwnerAlertResult> & { why?: string }) | null | undefined): { label: string; status: 'done' | 'info' } {
  if (!r) return { label: '⚠️ Not sent to WhatsApp — WhatsApp is not available on this server', status: 'info' };
  if (r.sent) {
    if (r.via === 'telegram') return { label: REFUSED_ON_TELEGRAM, status: 'done' };
    if (r.via === 'text') return { label: `WhatsApp sent (free text) — ${r.note || NOT_APPROVED_NOTE}`, status: 'done' };
    const tail = r.followUp === 'failed' ? ' — the longer follow-up text did not go through' : '';
    const unconfirmed = r.delivery === 'unconfirmed' ? ' — delivery unconfirmed' : '';
    return { label: `WhatsApp sent (template)${unconfirmed}${tail}`, status: 'done' };
  }
  if (r.delivery === 'refused') {
    if (r.telegram === 'already') return { label: '⚠️ WhatsApp refused by Meta (engagement pacing) — this alert already went out on Telegram', status: 'info' };
    return { label: `⚠️ WhatsApp refused by Meta (engagement pacing) — and Telegram could not carry it (${r.telegramWhy || 'Telegram is not set up'})`, status: 'info' };
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
