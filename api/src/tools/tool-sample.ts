import { createHash } from 'crypto';

/**
 * The pure half of the sample store (BEA-1386, agent workers 1/10 — `specs/AGENT-WORKERS.md` §A) — the caps, the
 * masker, the args hash and the one place that decides whether an answer may be kept at all.
 *
 * Why this exists: `ToolCall.result` is pretty-printed and cut to 2,000 characters, so no worker can
 * be tested or repaired against a real answer today. A repair must NEVER re-call a vendor (that
 * spends the owner's credits), so the answer has to be on disk, whole.
 *
 * The rule that outranks everything else here: **sampling is opt-in per service and must never keep
 * anybody's messages.** A vendor answer is other people's personal data, and a store we forget about
 * keeps it for ever. Three separate guards say no — the opt-in list, the deny list, and the masker —
 * and a sample is written only when all three agree.
 */

// ---- caps: one place, exported, so nothing invents its own number ---------------------------

/**
 * Per payload, BEFORE gzip. A bigger answer is stored truncated and marked unusable for tests.
 *
 * **2 MB, not 256 KB, since BEA-1395.** The acceptance run measured the owner's own flagship job:
 * one real `svc:instagram.profile` answer is **436 KB** — the profile carries its whole video
 * timeline, dash manifests and all — so at 256 KB every single answer that job ever gets would be
 * kept truncated and marked unusable, and no worker for it could ever be built, tested or repaired
 * against a real answer. The store stays bounded by the two caps that actually cost disk: the
 * gzipped ceiling below (that 436 KB answer is 64 KB gzipped) and `TOTAL_BUDGET_MB`.
 */
export const RAW_MAX = 2 * 1024 * 1024;
/** Per payload, AFTER gzip. Vendor JSON at the raw cap gzips far below this — belt to the braces. */
export const SAMPLE_MAX_BYTES = 1024 * 1024;
/** How many good samples are kept per (actionId, argsHash) — one call shape, five real answers. */
export const PER_ACTION_GOOD = 5;
/** How many failing samples are kept per job. Evidence of a break, not a log. */
export const PER_AGENT_FAILING = 10;
/** The whole store's ceiling. The nightly backup copies the database in full, so this is real disk. */
export const TOTAL_BUDGET_MB = 100;
export const TOTAL_BUDGET_BYTES = TOTAL_BUDGET_MB * 1024 * 1024;
/** How often the eviction sweep runs. */
export const SWEEP_EVERY_MS = 6 * 3600_000;
/** How long after boot the first sweep runs — after the post-deploy stampede, never during it. */
export const FIRST_SWEEP_AFTER_MS = 120_000;

// ---- who may be sampled ----------------------------------------------------------------------

/**
 * Opt-in, per service. Nothing is sampled because it happens to be a read — a service is on this
 * list only when its answers are public content a worker genuinely needs to be tested against.
 * Starts where the workers start: the social read platforms the owner's jobs already fetch.
 */
export const SAMPLE_SERVICES: ReadonlySet<string> = new Set([
  'instagram',
  'tiktok',
  'youtube',
  'twitter',
  'linkedin',
  'facebook',
  'threads',
  'reddit',
]);

/**
 * Never sampled, whatever else says yes. The opt-in list already excludes these; this is the second
 * lock, so that adding a service above can never quietly open one of them.
 */
export const NO_SAMPLE_SERVICES: ReadonlySet<string> = new Set([
  'vault',
  'whatsapp',
  'gmail',
  'googlemail',
  'mail',
  'outlook',
  'chat',
  'googlechat',
  'slack',
  'telegram',
  'discord',
  'messenger',
  'imessage',
  'sms',
  'twilio',
]);

/**
 * An action whose answer carries message bodies — a direct message, an inbox, a mail thread. Matched
 * on the ACTION half of the id only: `svc:threads.user_posts` is a public post, not a conversation,
 * and matching the whole id would catch the Threads platform by its name.
 */
export const NO_SAMPLE_ACTION_RE = /(^|[._-])(messages?|dms?|direct|inbox|conversations?|chats?|mails?|emails?)([._-]|$)/i;

// ---- masking ---------------------------------------------------------------------------------

/** What a masked value reads as. Short, and never mistaken for real data. */
export const MASK = '•••';
export const SECRET_MASK = '••••';

/** Anything whose NAME says it is a secret. The same rule the `ToolCall` recorder uses. */
export const SECRET_KEY_RE = /secret|token|password|api[-_ ]?key|credential|private[-_ ]?key/i;

/**
 * Anything whose NAME says it is somebody's contact detail. This is the half `redact()` cannot do —
 * it was written for small request arguments and masks by key name from a secrets list, so a phone
 * number in `wa_id` or an e-mail in `from` walks straight through it.
 */
export const PERSONAL_KEY_RE =
  /(^|[._-])(phone|phone_?number|mobile|msisdn|whatsapp|wa_id|wa_number|email|e_?mail|email_?address|contact_?number|address|street|postcode|post_?code|zipcode|dob|date_of_birth|birthday|national_id|aadhaar|ssn|from|sender|recipient|recipients|reply_to)([._-]|$)/i;

/**
 * Keys that hold an id. Their long digit runs are kept as they are: an Instagram `pk` IS a run of
 * digits, and masking it would destroy exactly the field a worker de-dupes on. An e-mail or an
 * E.164 number inside one is still masked — an id never contains either.
 */
export const ID_KEY_RE = /(^|[._-])(id|ids|pk|uid|gid|fbid|cid|code|shortcode)([._-]|$)|_id$/i;

/**
 * Keys that hold a time. `taken_at` in epoch seconds is a 10-digit run, which is phone-shaped; the
 * date fields are how a worker filters "the last 30 days", so they are kept too.
 */
export const DATE_KEY_RE = /(^|[._-])(at|ts|time|timestamp|date|epoch|expires|created|updated|published|taken)([._-]|$)|_at$|_ts$|_time$|_date$/i;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** E.164 and anything written like a dialled number: a leading +, then 8–17 digits and separators. */
const E164_RE = /\+\d[\d\s().-]{6,18}\d/g;
/**
 * A phone number written without its `+`, however it is spaced: `919000607141`, `98765 43210`,
 * `9876-543-210`, `(080) 4567 8901`. The regex finds a run of digits and separators; the digit COUNT
 * inside it decides — 10 to 14 digits is a phone number, anything else is left exactly as it was
 * (a 19-digit media id, a 4-digit year). This is the shape a bio actually carries.
 */
const PHONE_RUN_RE = /\d[\d\s().-]{7,20}\d/g;
const PHONE_MIN_DIGITS = 10;
const PHONE_MAX_DIGITS = 14;

/** How deep the masker walks. Deep enough for a real vendor answer, bounded so nothing can loop. */
const MASK_MAX_DEPTH = 12;

/**
 * Mask one string: by SHAPE, wherever the shape appears — including in the middle of a caption or a
 * bio, which is where a phone number or an e-mail actually turns up in a social answer. The string
 * stays a string and keeps everything around the masked part, so a test still exercises the real
 * shape of the answer.
 */
export function maskText(value: string, key = ''): string {
  let out = String(value).replace(EMAIL_RE, MASK).replace(E164_RE, MASK);
  // A bare digit run is a phone number OR an id OR a timestamp. When the key says which, believe it.
  if (!(ID_KEY_RE.test(key) || DATE_KEY_RE.test(key))) {
    out = out.replace(PHONE_RUN_RE, (m) => {
      const digits = m.replace(/\D/g, '').length;
      return digits >= PHONE_MIN_DIGITS && digits <= PHONE_MAX_DIGITS ? MASK : m;
    });
  }
  return out;
}

/**
 * Mask a whole vendor answer: by key name AND by value shape, with no length cap and no change to
 * the structure or the types. This is NOT `redact()` — that one truncates at 4,000 characters and
 * only looks at key names, and both of those would make a stored answer useless, unsafe, or both.
 */
export function maskPayload(value: any, key = '', depth = 0): any {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return maskText(value, key);
  // Numbers are left alone unless their KEY says whose they are: an id, an epoch and a follower
  // count are all long numbers, and masking those would empty the answer of what it is for.
  if (typeof value !== 'object') return value;
  if (depth >= MASK_MAX_DEPTH) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) return value.map((v) => maskPayload(v, key, depth + 1));

  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = SECRET_MASK;
      continue;
    }
    if (PERSONAL_KEY_RE.test(k)) {
      // Masked whole, keeping the type: a string becomes the mask, a number becomes 0, and an
      // object under it is still walked (a `from` block has a name and an id inside it).
      if (typeof v === 'string') out[k] = MASK;
      else if (typeof v === 'number') out[k] = 0;
      else out[k] = maskPayload(v, k, depth + 1);
      continue;
    }
    out[k] = maskPayload(v, k, depth + 1);
  }
  return out;
}

// ---- the args hash ---------------------------------------------------------------------------

/** JSON with the keys in a fixed order, so the same call always hashes to the same string. */
export function stableStringify(value: any): string {
  const walk = (v: any, depth = 0): any => {
    if (!v || typeof v !== 'object' || depth > MASK_MAX_DEPTH) return v;
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, any> = {};
    for (const k of Object.keys(v).sort()) out[k] = walk((v as any)[k], depth + 1);
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? 'null';
  } catch {
    return String(value);
  }
}

/** sha256 of the normalised (masked, key-sorted) arguments. One set of samples per call shape. */
export function argsHashOf(args: any): string {
  return createHash('sha256').update(stableStringify(maskPayload(args ?? {}))).digest('hex');
}

// ---- may this answer be kept? ----------------------------------------------------------------

/** The provider whose answers may be sampled: the public-scraping one, and only it. */
export const SAMPLE_PROVIDER = 'social';

export type SampleCandidate = {
  actionId: string;
  service?: string;
  /**
   * WHICH provider actually served this id. Two providers can own the same service slug — the
   * general one has a `twitter` toolkit signed in to the owner's OWN account, the scraping one has a
   * `twitter` that reads public posts — and only the id says which answered. A read of the owner's
   * own account is his address book, not public content, so the slug alone may never open the store.
   */
  providerKind?: string;
  /** Only a real success is ever kept — a failure has no answer to test against. */
  ok?: boolean;
  /** A call that had to stop and ask is never sampled: a send is not a read. */
  gated?: boolean;
  /** The provider says every one of its actions is a read. */
  readOnly?: boolean;
  /** The action's own HTTP verb, when the provider gives one. */
  method?: string;
};

/**
 * The one decision. Deny beats allow, and every road but "a successful, ungated read of an opted-in
 * service" answers no.
 */
export function shouldSample(c: SampleCandidate): boolean {
  if (!c?.ok || c.gated) return false;
  if (c.providerKind !== SAMPLE_PROVIDER) return false;
  const id = String(c.actionId || '');
  const m = /^svc:([^.]+)\.(.+)$/.exec(id);
  if (!m) return false;
  const service = String(c.service || m[1] || '').toLowerCase();
  const action = m[2];
  if (NO_SAMPLE_SERVICES.has(service)) return false;
  if (!SAMPLE_SERVICES.has(service)) return false;
  if (NO_SAMPLE_ACTION_RE.test(action)) return false;
  const read = c.readOnly === true || String(c.method || '').toUpperCase() === 'GET';
  return read;
}

/**
 * The other door: **evidence of a break** (BEA-1393, the self-heal loop).
 *
 * `shouldSample()` decides what is worth keeping to test AGAINST — a successful, ungated read of an
 * opted-in public-content service, served by the scraping provider. A failure is a different
 * question: the answer that broke a worker is the one thing a repair needs to read, whichever
 * service it came from and however the call went, so the allow-list and the provider check do not
 * apply here.
 *
 * What DOES still apply is the privacy half, and it applies exactly as strictly: a service on
 * `NO_SAMPLE_SERVICES` (the vault, WhatsApp, Gmail, chat, Telegram…) and anything that reads like
 * somebody's messages are never stored, broken or not. Evidence is never worth keeping a person's
 * conversation for.
 */
export function mayKeepFailing(actionId: string, service?: string): boolean {
  const m = /^svc:([^.]+)\.(.+)$/.exec(String(actionId || ''));
  if (!m) return false;
  const slug = String(service || m[1] || '').toLowerCase();
  if (NO_SAMPLE_SERVICES.has(slug)) return false;
  return !NO_SAMPLE_ACTION_RE.test(m[2]);
}

// ---- notes -----------------------------------------------------------------------------------

/** How a note starts when the answer was too big to keep whole. `isUsable()` reads this. */
export const TRUNCATED_PREFIX = 'truncated:';

/** A sample kept as evidence but cut short cannot be replayed — a cut JSON does not parse. */
export function isUsable(sample: { note?: string | null } | null | undefined): boolean {
  return !!sample && !String(sample.note || '').startsWith(TRUNCATED_PREFIX);
}

export function truncatedNote(rawBytes: number): string {
  return `${TRUNCATED_PREFIX} the answer was ${Math.round(rawBytes / 1024).toLocaleString('en-US')} KB, over the ${Math.round(RAW_MAX / 1024)} KB cap — kept as evidence, not usable for tests.`;
}
