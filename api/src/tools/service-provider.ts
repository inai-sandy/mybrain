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
};

/** The seam itself. One implementation today (`ComposioProvider`); the catalog knows only this. */
export interface ServiceProvider {
  /** Every service, or just the connected ones. Blocked services are never returned. */
  listServices(opts?: { connectedOnly?: boolean; search?: string; category?: string; limit?: number }): Promise<ServiceInfo[]>;
  /** One service by its slug, in full — including what it wants signing in with. Null if unknown. */
  getService(slug: string): Promise<ServiceInfo | null>;
  /** The actions of one service, with their argument schemas. */
  listActions(service: string, opts?: { important?: boolean; limit?: number; search?: string }): Promise<ServiceAction[]>;
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
  /** Run one action. `actionId` is our `svc:` id, never the vendor's. */
  execute(actionId: string, args?: Record<string, any>, opts?: { connectionId?: string }): Promise<ExecuteResult>;
  /** Is a key set, and does it work? Never throws. */
  status(): Promise<ProviderStatus>;
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
 * Actions that cannot be undone, by rule (specs/TOOLS.md → Gates).
 *
 * 1,209 services cannot be hand-tagged, so the rules come first and a hand-kept list second. This
 * only FLAGS an action — the pause-and-ask gate itself is BEA-1348.
 */
const RISKY_PREFIXES = ['DELETE_', 'REMOVE_', 'MERGE_', 'ARCHIVE_', 'REVOKE_', 'TRANSFER_', 'REFUND_', 'CANCEL_', 'BLOCK_', 'INVITE_'];
const RISKY_SUFFIXES = ['_COLLABORATOR', '_COLLABORATORS', '_ROLE', '_ROLES', '_PERMISSIONS'];

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
  if (RISKY_PREFIXES.some((p) => body.startsWith(p))) return true;
  return RISKY_SUFFIXES.some((s) => body.endsWith(s));
}
