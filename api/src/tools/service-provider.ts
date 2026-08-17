/**
 * The ServiceProvider seam (BEA-1345) — how outside services reach our one tool catalog.
 *
 * Full design: `specs/TOOLS.md`.
 *
 * Nothing above this file may know WHICH vendor supplies a service. The catalog, the tool picker,
 * the Flows canvas and every saved flow only ever see an id of the shape `svc:<service>.<action>`
 * (`svc:github.create_issue`). The provider is the only place that knows the vendor's own name for
 * it (`GITHUB_CREATE_ISSUE`).
 *
 * **Why the id may never say "composio":** flow tool ids are load-bearing — `flows-runner.service.ts`
 * dispatches on them and they are stored inside flows already saved in the database. A vendor name
 * baked into an id would make the provider unswappable for ever.
 */

/** One connected account of a service. Several are allowed per service (two Gmail inboxes). */
export type ServiceAccount = {
  /** The provider's id for the connection — what `execute()` and `disconnect()` take. */
  id: string;
  /** Something the owner recognises ("sandy@kiot.io"), never an opaque id if we can help it. */
  label: string;
  /** ACTIVE | INITIALIZING | INACTIVE | EXPIRED | FAILED — the provider's own word, upper-cased. */
  status: string;
  connectedAt?: string;
  lastUsedAt?: string;
};

/** One thing the owner has to type in before a service can be connected. */
export type CredentialField = { name: string; label: string; description?: string; required?: boolean; secret?: boolean };

/** One service (Composio calls it a toolkit). Counts are always read live — never hard-coded. */
export type ServiceInfo = {
  slug: string;
  name: string;
  /** The first category, for display. */
  category: string;
  /** EVERY category the service is filed under — a service is usually in two or three. */
  categories?: { id: string; name: string }[];
  connected: boolean;
  accounts: ServiceAccount[];
  description?: string;
  logo?: string;
  /** Read from the API at run time. The vendor's docs and marketing pages disagree with it. */
  actionCount?: number;
  triggerCount?: number;
  /**
   * FALSE means the vendor has no managed auth for this service (Vercel is the known case) and the
   * owner must supply their own OAuth app before it can be connected. The UI must show that rather
   * than offer a one-click flow that cannot work.
   */
  managedAuth?: boolean;
  /**
   * No login needed at all (32 of the 1,209 are open — Hacker News, the weather, a PDF writer).
   *
   * Verified live: the vendor REFUSES to create a login config for one of these ("works without an
   * auth config … use its tools directly"), so the UI must say "ready to use" rather than offer a
   * Connect button that can only ever produce an error.
   */
  noAuth?: boolean;
  authSchemes?: string[];
  /** OAUTH2 · API_KEY · BEARER_TOKEN … — how this service is signed into. */
  authMode?: string;
  /** Everything the owner must supply when `managedAuth` is false — both halves, in one list. */
  needs?: CredentialField[];
  /**
   * The same fields, split the way the vendor actually wants them, because the two halves go to
   * two different calls and sending one to the other's endpoint silently does nothing:
   *  - `needsAuthConfig` — an OAuth app's client id/secret, given when the login config is made.
   *  - `needsAccount` — an API key or bearer token, given when the account itself is created.
   * Verified live 2026-08-16: Vercel's only field (`bearer_token`) is in the SECOND half, and
   * Twitter's three (`client_id`, `client_secret`, `generic_id`) are all in the first.
   */
  needsAuthConfig?: CredentialField[];
  needsAccount?: CredentialField[];
};

/** One callable action, with the JSON schema an agent needs to fill its arguments. */
export type ServiceAction = {
  /** `svc:<service>.<action>` — the only id anything above this seam sees. */
  id: string;
  name: string;
  description: string;
  schema: any;
  /** Matches the "can't be undone" rules — the gate in BEA-1348 acts on this. */
  risky: boolean;
  service: string;
  deprecated?: boolean;
  /**
   * The vendor's own "most used" mark, when it gives one (BEA-1354). It no longer decides what the
   * catalog holds — every action is in it — but it is a fair tie-break when a PROMPT can only carry
   * a shortlist and the owner's words match nothing.
   */
  important?: boolean;
  /**
   * Extras a spec-generated provider can carry (BEA-1355) — all optional, so a provider that does
   * not know them (Composio) is unchanged. `tags` is the vendor's own grouping of the action
   * ("Instagram", "Facebook Ad Library"), `costHint` the vendor's own sentence about what it costs
   * when the spec states one — a HINT, never the charge itself, which is read off every response.
   */
  method?: string;
  path?: string;
  tags?: string[];
  costHint?: string;
  /** What one answer looks like, when the vendor's spec shows one. */
  responseExample?: any;
};

/**
 * One kind of event a service can tell us about (BEA-1350) — "a pull request was opened".
 *
 * `instant` and `everyMinutes` are read off the provider at run time and never guessed. The vendor
 * says for each event whether it is pushed the moment it happens or looked up on a timer, and the
 * timer's length is a field on the event's own settings. The owner is told which one he is picking,
 * because "new email" meaning "within a few minutes" changes what a rule is worth building.
 */
export type ServiceTrigger = {
  /** `evt:<service>.<event>` — the only id anything above this seam sees. */
  id: string;
  name: string;
  description: string;
  service: string;
  /** True when the service pushes it as it happens; false when it is looked up on a timer. */
  instant: boolean;
  /** How often it is looked up, in minutes, when it is not instant. */
  everyMinutes?: number;
  /** The JSON schema of the event's own settings — which repo, which channel, which label. */
  config: any;
  /** What one of these events looks like, when the provider publishes it. */
  payloadSchema?: any;
};

/** What happened when we asked the provider to start (or stop) listening. */
export type TriggerInstanceResult = {
  ok?: boolean;
  /** The provider's id for the live subscription — what stops it again later. */
  instanceId?: string;
  /** Plain English, safe to show. */
  message?: string;
};

/** Where the provider should post events, and the secret it signs them with. */
export type EventDelivery = {
  ok?: boolean;
  url?: string;
  /** The provider's own signing secret, when it gives one. Never shown to the owner. */
  signingSecret?: string;
  message?: string;
};

/** The result of starting a connection. Optional fields, never a union — this repo is `strict: false`. */
export type ConnectResult = {
  ok?: boolean;
  /** Where to send the owner to finish the login. */
  redirectUrl?: string;
  connectionId?: string;
  status?: string;
  /** True when the service has no vendor-managed auth: the owner must add their own credentials. */
  needsCredentials?: boolean;
  /** Which credentials, in that case. */
  fields?: CredentialField[];
  /** Plain English, safe to show. */
  message?: string;
  /** True when the connection finished right here and there is nowhere to send the owner. */
  done?: boolean;
};

export type ProviderStatus = {
  configured: boolean;
  reachable: boolean;
  message?: string;
  /** How many services the key can see, when we could ask. */
  serviceCount?: number;
};

export type ExecuteResult = {
  ok?: boolean;
  data?: any;
  error?: string;
  ms?: number;
  /**
   * What the call cost in the provider's own credits, read off ITS answer (BEA-1355) — never
   * assumed. Undefined when the provider does not meter calls (Composio). A cache hit at the
   * provider is an honest 0, and 0 is recorded as 0.
   */
  credits?: number;
  /**
   * The HTTP status the provider answered with, when it failed and there was one (BEA-1356). Only
   * so a screen can tell "out of credits" (402) from "the far end refused" and say the right thing;
   * the sentence in `error` is still the message to show.
   */
  status?: number;
};

/**
 * The seam itself. Two implementations today (`ComposioProvider`, `ScrapeCreatorsProvider`); the
 * catalog and the run path know only this.
 */
export interface ServiceProvider {
  /** Every service, or just the connected ones. Blocked services are never returned. */
  listServices(opts?: { connectedOnly?: boolean; search?: string; category?: string; limit?: number }): Promise<ServiceInfo[]>;
  /** One service by its slug, in full — including what it wants signing in with. Null if unknown. */
  getService(slug: string): Promise<ServiceInfo | null>;
  /**
   * The actions of one service, with their argument schemas — ALL of them by default (BEA-1354:
   * "do not skip any action from providers"). `important` narrows to the vendor's own shortlist and
   * `limit` caps the walk; both are opt-in and nothing in the catalog uses them any more.
   */
  listActions(service: string, opts?: { important?: boolean; limit?: number; search?: string }): Promise<ServiceAction[]>;
  /**
   * A number that changes whenever the provider forgets what it read (a connect, a disconnect, a
   * refresh). The catalog keeps its own last-good copy and uses this to know that copy is stale
   * for a reason, not just for age. Optional — a provider without it is treated as never stale.
   */
  generation?(): number;
  /**
   * ONE action by our id, with the JSON schema its arguments are filled from. Null if unknown.
   *
   * An exact fetch on purpose (BEA-1347). The list endpoint's `search` is not semantic — asked for
   * `GITHUB_GET_THE_AUTHENTICATED_USER` it answers with `..._CREATE_OR_UPDATE_A_SECRET_...` first —
   * so a step must never find its own action by searching for it. Optional so a stub provider in a
   * spec need not implement it.
   */
  getAction?(actionId: string): Promise<ServiceAction | null>;
  /** Start a login. Returns somewhere to send the owner, or what is missing. */
  connect(service: string, opts?: { label?: string; callbackUrl?: string; credentials?: Record<string, any> }): Promise<ConnectResult>;
  /** Drop one connected account. */
  disconnect(connectionId: string): Promise<{ ok: boolean; message?: string }>;
  /** Give one connected account a name the owner recognises ("work gmail"). Our own bookkeeping. */
  renameConnection(connectionId: string, label: string): Promise<{ ok: boolean; message?: string }>;
  /** Throw away what was read a moment ago, so the next read asks the provider again. */
  refresh?(): void;
  /**
   * Run one action. `actionId` is our `svc:` id, never the vendor's.
   *
   * `timeoutMs` is for the few calls that legitimately take longer than an API call should — a
   * Drive export the provider has to build before it can hand it over. Everything else uses the
   * provider's own default.
   */
  execute(actionId: string, args?: Record<string, any>, opts?: { connectionId?: string; timeoutMs?: number }): Promise<ExecuteResult>;

  // ---- events (BEA-1350) — optional, so a stub provider in a spec need not implement them -------

  /**
   * The events this service can tell us about. **Enumerate; never assume there are any.** Read live
   * on 2026-08-16: GitHub 46, Linear 12, Slack 9, Notion 8, Google Calendar 7, Drive 7, Gmail 2 —
   * and Sentry and Vercel have NONE at all, so a connected service with an empty list is normal and
   * the UI must say so rather than draw an empty picker.
   */
  listTriggers?(service: string): Promise<ServiceTrigger[]>;
  /** Start listening. `triggerId` is our `evt:` id, never the vendor's. */
  createTriggerInstance?(triggerId: string, config?: Record<string, any>, opts?: { connectionId?: string }): Promise<TriggerInstanceResult>;
  /** Stop listening, and take the subscription away at the provider so it bills nothing more. */
  deleteTriggerInstance?(instanceId: string): Promise<TriggerInstanceResult>;
  /** Point the provider's event delivery at one URL of ours, and learn what it signs with. */
  ensureEventDelivery?(url: string): Promise<EventDelivery>;
  /** Is a key set, and does it work? Never throws. */
  status(): Promise<ProviderStatus>;
  /**
   * TRUE when EVERY action this provider has is a read (BEA-1355 — ScrapeCreators only scrapes).
   * The gate then does not re-run the name rule on its ids, because that rule was tuned for
   * Composio's `<VERB>_<NOUN>` slugs and a path-derived read called `…/block/…` must never be
   * held for approval. Absent (Composio) means "decide per action, and re-check the rule".
   */
  readOnly?: boolean;
}

// ---- ids -----------------------------------------------------------------------------------

/** The one shape a service tool id may take. Anything else is not ours. */
export const SERVICE_TOOL_ID_RE = /^svc:[a-z0-9_]+\.[a-z0-9_]+$/;

export function isServiceToolId(id: string): boolean {
  return SERVICE_TOOL_ID_RE.test(String(id || ''));
}

/** `('github','CREATE_ISSUE')` → `svc:github.create_issue`. */
export function serviceToolId(service: string, action: string): string {
  return `svc:${String(service || '').toLowerCase()}.${String(action || '').toLowerCase()}`;
}

/** `svc:github.create_issue` → `{ service:'github', action:'create_issue' }`, else null. */
export function parseServiceToolId(id: string): { service: string; action: string } | null {
  if (!isServiceToolId(id)) return null;
  const rest = String(id).slice(4);
  const dot = rest.indexOf('.');
  return { service: rest.slice(0, dot), action: rest.slice(dot + 1) };
}

/**
 * Our id → the vendor's action slug. `svc:github.create_issue` → `GITHUB_CREATE_ISSUE`.
 *
 * Verified against the live API on 2026-08-16: every action slug is `[A-Z0-9_]+` and starts with
 * its toolkit slug upper-cased, and every toolkit slug is `[a-z0-9_]+`. That makes the mapping a
 * pure round-trip in both directions — no lookup table to fall out of date.
 */
export function vendorActionSlug(id: string): string | null {
  const parsed = parseServiceToolId(id);
  if (!parsed) return null;
  const prefix = parsed.service.toUpperCase();
  const action = parsed.action.toUpperCase();
  return action.startsWith(`${prefix}_`) ? action : `${prefix}_${action}`;
}

/** The vendor's slug → our id. `('github','GITHUB_CREATE_ISSUE')` → `svc:github.create_issue`. */
export function toolIdFromVendorSlug(service: string, slug: string): string {
  const svc = String(service || '').toLowerCase();
  const raw = String(slug || '');
  const prefix = `${svc.toUpperCase()}_`;
  const action = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return serviceToolId(svc, action);
}

// ---- event ids (BEA-1350) ------------------------------------------------------------------

/**
 * The same shape as a tool id, for the other direction: `evt:github.pull_request_event`.
 *
 * Same reason, too. A binding row stores this id for as long as the rule exists, so a vendor name
 * inside it would make the provider unswappable — and a rule the owner set up a year ago is exactly
 * the thing that must survive a change of supplier.
 */
export const SERVICE_EVENT_ID_RE = /^evt:[a-z0-9_]+\.[a-z0-9_]+$/;

export function isServiceEventId(id: string): boolean {
  return SERVICE_EVENT_ID_RE.test(String(id || ''));
}

/** `('github','GITHUB_PULL_REQUEST_EVENT')` → `evt:github.pull_request_event`. */
export function serviceEventId(service: string, trigger: string): string {
  const svc = String(service || '').toLowerCase();
  const raw = String(trigger || '');
  const prefix = `${svc.toUpperCase()}_`;
  const body = raw.toUpperCase().startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return `evt:${svc}.${body.toLowerCase()}`;
}

/** `evt:github.pull_request_event` → `{ service:'github', trigger:'pull_request_event' }`, else null. */
export function parseServiceEventId(id: string): { service: string; trigger: string } | null {
  if (!isServiceEventId(id)) return null;
  const rest = String(id).slice(4);
  const dot = rest.indexOf('.');
  return { service: rest.slice(0, dot), trigger: rest.slice(dot + 1) };
}

/**
 * Our id → the vendor's event slug. `evt:github.pull_request_event` → `GITHUB_PULL_REQUEST_EVENT`.
 *
 * A pure round trip, checked against the live API on 2026-08-16: **all 362 event types** across
 * every toolkit are `[A-Z0-9_]+` and start with their toolkit's slug upper-cased, exactly like the
 * action slugs. So there is no lookup table here either, and none to fall out of date.
 */
export function vendorTriggerSlug(id: string): string | null {
  const parsed = parseServiceEventId(id);
  if (!parsed) return null;
  const prefix = parsed.service.toUpperCase();
  const trigger = parsed.trigger.toUpperCase();
  return trigger.startsWith(`${prefix}_`) ? trigger : `${prefix}_${trigger}`;
}

// ---- what we never hand out --------------------------------------------------------------

/**
 * Services that must never appear in the catalog.
 *
 * Not a safety list — a "we already do this better, or it is ours" list. Our own web research is
 * budgeted and cited (`deep-research.service.ts`); WhatsApp is a real Pinnacle BSP number; Telegram
 * is our own bot. Routing any of them through a third party would hand back control we took on
 * purpose (BEA-1194) and bill us twice. Google is deliberately NOT blocked — it moves over later.
 */
export const BLOCKED_SERVICES: string[] = ['exa', 'firecrawl', 'tavily', 'perplexity', 'telegram', 'whatsapp'];

export function isBlockedService(slug: string): boolean {
  return BLOCKED_SERVICES.includes(String(slug || '').toLowerCase());
}

/**
 * Actions that cannot be undone, by rule (specs/TOOLS.md → Gates). The gate itself is BEA-1348;
 * this function is the one place that decides WHAT is gated, and there is deliberately no second
 * rule set anywhere else.
 *
 * 1,209 services cannot be hand-tagged, so: rules first, hand-kept lists second.
 *
 * **The failure that matters here is over-gating.** The owner chose full access with gates on the
 * understanding that he sees one "maybe once a week, so I'll actually read it". A gate on every
 * other step is a gate nobody reads, which is worse than no gate at all. So a read is NEVER gated,
 * and things that can plainly be put back (a label taken off an issue, a reaction removed) are on
 * the allow list even though the word REMOVE is in their name.
 *
 * Audited against the live Composio API on 2026-08-16 — the counts are in `specs/TOOLS.md`.
 */

/** Verbs that only ever LOOK at something. A read is never gated, whatever else its name says. */
const READ_VERBS = ['GET', 'LIST', 'SEARCH', 'FIND', 'FETCH', 'READ', 'CHECK', 'COUNT', 'VIEW', 'RETRIEVE', 'DESCRIBE', 'DOWNLOAD', 'EXPORT', 'COMPARE', 'VERIFY'];

/** The rule from the spec: an action that STARTS with one of these cannot be taken back. */
const RISKY_PREFIXES = ['DELETE_', 'REMOVE_', 'MERGE_', 'ARCHIVE_', 'REVOKE_', 'TRANSFER_', 'REFUND_', 'CANCEL_', 'BLOCK_', 'INVITE_'];

/**
 * The same idea as a word anywhere in the name, for the toolkits that put the verb in the middle
 * (`FORCE_CANCEL_A_WORKFLOW_RUN`, `..._PERMANENTLY_DELETE_...`). Only words whose meaning is
 * "it is gone" — nothing that merely changes something.
 */
const RISKY_WORDS = ['DELETE', 'DESTROY', 'PURGE', 'ERASE', 'WIPE', 'REVOKE', 'REFUND', 'TERMINATE', 'CANCEL'];

/** `SLACK_DELETES_A_MESSAGE_FROM_A_CHAT` is real, and deleting a message is still deleting it. */
const isRiskyWord = (w: string) => RISKY_WORDS.includes(w) || (w.endsWith('S') && RISKY_WORDS.includes(w.slice(0, -1)));

/**
 * Who can do what. The spec's `*_COLLABORATOR · *_ROLE · *_PERMISSIONS` rule, widened from "ends
 * with" to "contains", because the real slugs put the object in the middle
 * (`ASSIGN_AN_ORGANIZATION_ROLE_TO_A_USER`, `ADD_OR_UPDATE_TEAM_REPOSITORY_PERMISSIONS`).
 *
 * These are the WEAK triggers: they gate only when the action is not a read. `LIST_COLLABORATORS`
 * and `VERIFY_DEV_CONTAINER_PERMISSIONS_ACCEPTED` are reads with an access word in the name, and
 * gating those is exactly the over-gating that would train the owner to tap through.
 */
const ACCESS_WORDS = ['COLLABORATOR', 'COLLABORATORS', 'ROLE', 'ROLES', 'PERMISSION', 'PERMISSIONS'];

/**
 * Hand-kept: things that cannot be taken back and that no rule above catches. Matched as a phrase
 * inside the action's name. Kept SHORT on purpose — every entry needs a real reason.
 *
 *  • `RESET_A_TOKEN` — GitHub. The old token stops working the moment it runs; everything using it
 *    breaks, and there is no putting it back.
 *  • `CONFIRM_PAYMENT` / `CAPTURE_PAYMENT` / `PAYOUT` — Stripe. Real money leaves, and the only
 *    "undo" is a separate refund.
 *
 * Deliberately NOT here: `GMAIL_MOVE_TO_TRASH` (untrash puts it back), `LOCK_AN_ISSUE` (unlock),
 * `SLACK_CLOSE_DM` (re-open). They read as scary and are all reversible.
 */
const MUST_GATE = ['RESET_A_TOKEN', 'CONFIRM_PAYMENT', 'CAPTURE_PAYMENT', 'PAYOUT'];

/**
 * Hand-kept the other way: names that trip a rule but put back in one click. All of these are
 * "detach X from Y", where re-attaching is the same call with a different verb.
 *
 * Each entry is [a verb it must start with, a word it must contain]; an access word anywhere in
 * the name cancels the allowance, so `REMOVE_A_REPOSITORY_COLLABORATOR` still gates.
 */
const ALLOWED: [string, string][] = [
  ['REMOVE', 'LABEL'], ['REMOVE', 'LABELS'],           // taking a label off an issue, a runner, a mail
  ['REMOVE', 'ASSIGNEE'], ['REMOVE', 'ASSIGNEES'],     // un-assigning someone
  ['REMOVE', 'REVIEWER'], ['REMOVE', 'REVIEWERS'],     // un-requesting a review
  ['REMOVE', 'REACTION'], ['DELETE', 'REACTION'],      // a thumbs-up
  ['REMOVE', 'STAR'], ['DELETE', 'STAR'],              // un-starring
];

/** The action's own words, with the service prefix taken off. `svc:` id or vendor slug, either way. */
function actionWords(action: string, service?: string): string[] {
  const asId = parseServiceToolId(action);
  const svc = (asId?.service || service || '').toUpperCase();
  let body = (asId?.action || String(action || '')).toUpperCase();
  if (svc && body.startsWith(`${svc}_`)) body = body.slice(svc.length + 1);
  return body.split(/[^A-Z0-9]+/).filter(Boolean);
}

/**
 * Does this action only LOOK at something?
 *
 * One definition, used twice: the gate never stops a read (BEA-1348), and the echo guard never
 * blames one for an event (BEA-1350) — reading a list of issues cannot have created an issue.
 *
 * Only the FIRST word counts, and that is deliberate: every action slug in this catalog is
 * `<VERB>_<the rest>` (checked across 1,061 live slugs on 2026-08-16 — GitHub, Slack, Stripe,
 * Linear, Notion, Gmail), so the first token IS the verb. Matching a read verb ANYWHERE would be the
 * dangerous version: `DELETE_A_LIST` would stop being gated.
 */
export function isReadAction(action: string, service?: string): boolean {
  const words = actionWords(action, service);
  return !!words.length && READ_VERBS.includes(words[0]);
}

/**
 * Takes the action, with or without its service prefix — `GITHUB_DELETE_A_REPOSITORY`,
 * `delete_a_repository`, or a whole `svc:` id.
 *
 * The service must be passed when a full vendor slug is given: 106 of the first 500 toolkit slugs
 * contain an underscore (`google_maps`, `microsoft_teams`), so "cut at the first underscore" would
 * strip half the service name and miss the rule.
 */
export function isRiskyAction(action: string, service?: string): boolean {
  const asId = parseServiceToolId(action);
  const svc = (asId?.service || service || '').toUpperCase();
  let body = (asId?.action || String(action || '')).toUpperCase();
  if (svc && body.startsWith(`${svc}_`)) body = body.slice(svc.length + 1);
  const words = body.split('_').filter(Boolean);
  if (!words.length) return false;

  /**
   * 1. A read is never gated, and nothing below can overturn it. `isReadAction()` above is the one
   * definition of "a read", and it explains why only the first word counts. If a provider ever ships
   * `GET_AND_DELETE_X`, that line is where it slips through — the test below is the tripwire.
   */
  if (READ_VERBS.includes(words[0])) return false;
  // 2. Hand-kept: the ones the rules miss.
  if (MUST_GATE.some((p) => body.includes(p))) return true;
  // 3. Hand-kept: the ones the rules get wrong.
  const hasAccessWord = words.some((w) => ACCESS_WORDS.includes(w));
  if (!hasAccessWord && ALLOWED.some(([verb, thing]) => words[0] === verb && words.includes(thing))) return false;
  // 4. The rules from the spec.
  if (RISKY_PREFIXES.some((p) => body.startsWith(p))) return true;
  if (words.some(isRiskyWord)) return true;
  // 5. Who-can-do-what, but only when the action is not looking something up.
  return hasAccessWord && !words.some((w) => READ_VERBS.includes(w));
}
