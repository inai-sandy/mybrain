import { isReadAction, parseServiceEventId, parseServiceToolId } from '../tools/service-provider';

/**
 * The echo guard (BEA-1350). Design: `specs/TOOLS.md` → Triggers.
 *
 * **The failure this exists to stop, in one line:** the agent posts to Slack → Slack tells us "a new
 * message" → the flow wakes → it posts again → for ever, until the month's 50,000 events are gone.
 * Nothing else in the system can break that circle, because every step of it is working correctly.
 *
 * So every inbound event is checked against the `ToolCall` log — the flight recorder every service
 * call already writes (BEA-1347) — and an event we plainly caused ourselves is dropped and written
 * down as an echo rather than run.
 *
 * Three rules, and the order matters:
 *
 *  1. **A read is never blamed.** Listing issues cannot have created an issue. `isReadAction()` in
 *     `service-provider.ts` is the one definition of a read; there is no second one here.
 *  2. **Identity — the strong rule.** If something our call *got back* (an id, a timestamp, a URL,
 *     a commit sha) appears verbatim inside the event, this event IS our own write coming home. No
 *     guessing involved, and it is the rule that catches the real loop.
 *  3. **Subject — the loose rule.** Failing that, the event and the call are about the same THING
 *     (both name a message, both name an issue) and the call happened within the last few minutes on
 *     the same service.
 *
 * Rule 3 is deliberately loose, and it is a trade made with open eyes: it can drop a genuine event
 * that arrived just after we wrote something similar. The alternative failure — a runaway loop
 * burning the quota — is far worse and far harder to notice. The window is short for exactly that
 * reason, every drop is visible in the binding's history with the call it blamed, and the owner can
 * see there was nothing wrong with his rule.
 *
 * What this must NOT do is filter on `runKind`. The same log now carries Chat's calls (BEA-1349) as
 * well as flow runs, and a message the owner sent from Chat echoes back exactly like one an agent
 * sent. Filtering to flow rows would leave that door wide open.
 */

/** One row of the flight recorder, as much of it as the guard reads. */
export type ToolCallRow = {
  id: string;
  service: string;
  /** OUR id: `svc:slack.chat_post_message`. */
  action: string;
  arguments?: string | null;
  result?: string | null;
  ok?: boolean;
  createdAt: Date | string;
};

export type EchoVerdict = {
  echo: boolean;
  /** The `ToolCall` row we blamed. */
  callId?: string;
  /** Plain English, written into the history so a dropped event is never a silent one. */
  why?: string;
};

/**
 * Words that say nothing about WHAT an event is about. Stripped from both sides before they are
 * compared, so "new message" and "send a message" match on `MESSAGE` and not on `NEW`.
 */
const NOISE = new Set([
  'A', 'AN', 'THE', 'TO', 'FROM', 'IN', 'ON', 'OF', 'FOR', 'AND', 'OR', 'BY', 'WITH', 'AT', 'ANY', 'ITS', 'THIS', 'THAT',
  'NEW', 'TRIGGER', 'EVENT', 'EVENTS', 'ADDED', 'CREATED', 'UPDATED', 'CHANGED', 'DELETED', 'REMOVED', 'RECEIVE', 'RECEIVED',
  'STATUS', 'ACTIVITY', 'NOTIFICATION', 'ITEM', 'ITEMS', 'DATA', 'INFO', 'DETAILS', 'ID', 'IDS', 'LIST',
  // The verbs on the action side. A verb tells us what we DID, not what it was done to.
  'CREATE', 'CREATES', 'POST', 'POSTS', 'SEND', 'SENDS', 'ADD', 'ADDS', 'UPDATE', 'UPDATES', 'WRITE', 'WRITES',
  'EDIT', 'EDITS', 'SET', 'MAKE', 'MAKES', 'PUT', 'PATCH', 'UPSERT', 'START', 'STARTS', 'OPEN', 'OPENS',
]);

/**
 * Words that are true of nearly everything a service does, so they prove nothing on their own.
 * Without this, "add a label to an issue" would look like the cause of "an issue was opened".
 */
const TOO_GENERIC = new Set(['REPO', 'REPOSITORY', 'REPOSITORIES', 'ORG', 'ORGANIZATION', 'ORGANISATION', 'USER', 'USERS', 'ACCOUNT', 'PROJECT', 'TEAM', 'WORKSPACE', 'CHANNEL', 'CHANNELS', 'FOLDER', 'PAGE', 'MAIL', 'GMAIL', 'SLACK', 'GITHUB', 'LABEL', 'LABELS', 'ASSIGNEE', 'ASSIGNEES', 'COMMENT', 'COMMENTS']);

/** Keys in what a service handed back that identify the very thing it just made for us. */
const IDENTITY_KEYS = /^(id|ts|number|sha|key|url|html_url|permalink|link|self|identifier|message_id|messageid|thread_ts|node_id|uid|guid|name|slug)$/i;

/** An identifier has to be distinctive to prove anything. "1" appears in every payload ever sent. */
const MIN_IDENTITY_CHARS = 6;

/** How many identifiers we bother to pull out of one call's result. */
const MAX_IDENTITIES = 12;

const words = (text: string): string[] => String(text || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);

/** What an id is ABOUT — its words, with the noise and the too-common ones taken out. */
export function subjectWords(rawWords: string[]): Set<string> {
  const out = new Set<string>();
  for (const w of rawWords) {
    if (w.length < 3 || NOISE.has(w) || TOO_GENERIC.has(w)) continue;
    // "MESSAGES" and "MESSAGE" are the same subject.
    out.add(w.endsWith('S') && w.length > 4 ? w.slice(0, -1) : w);
  }
  return out;
}

/** Every distinctive identifier a call got back — the strong half of the guard. */
export function identitiesOf(call: ToolCallRow): string[] {
  const found = new Set<string>();
  const walk = (v: any, key: string, depth: number) => {
    if (found.size >= MAX_IDENTITIES || depth > 5 || v === null || v === undefined) return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 20)) walk(x, key, depth + 1); return; }
    if (typeof v === 'object') { for (const [k, val] of Object.entries(v)) walk(val, k, depth + 1); return; }
    const s = String(v);
    if (!IDENTITY_KEYS.test(key) || s.length < MIN_IDENTITY_CHARS || s.length > 200) return;
    found.add(s);
  };
  const raw = String(call?.result || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { walk(JSON.parse(raw.slice(start, end + 1)), '', 0); } catch { /* not JSON — no identities to take */ }
  }
  return [...found];
}

/**
 * Did WE cause this event?
 *
 * `calls` must already be narrowed to the same service and to the time window — the caller does that
 * in one indexed query, and **never** narrows on `runKind`: a call Chat made echoes back exactly
 * like one an agent made, and `ToolCall.runId` on a chat row points at a chat session, not a run.
 */
export function findEcho(event: { triggerType?: string; payload?: any }, calls: ToolCallRow[]): EchoVerdict {
  const list = (calls || []).filter((c) => c && c.ok !== false && !isReadAction(c.action, c.service));
  if (!list.length) return { echo: false };

  const payloadText = safeText(event?.payload);
  const parsedEvent = parseServiceEventId(String(event?.triggerType || ''));
  const eventSubject = subjectWords(words(parsedEvent?.trigger || String(event?.triggerType || '')));

  // 1. Identity — something we were handed back is sitting inside this event.
  for (const c of list) {
    for (const identity of identitiesOf(c)) {
      if (payloadText.includes(identity)) {
        return { echo: true, callId: c.id, why: `We did this ourselves — ${actionName(c)} produced ${clip(identity)}, and that is what this event is about.` };
      }
    }
  }

  // 2. Subject — same thing, same service, moments ago.
  for (const c of list) {
    const callSubject = subjectWords(words(parseServiceToolId(c.action)?.action || c.action));
    const shared = [...eventSubject].filter((w) => callSubject.has(w));
    if (shared.length) {
      return { echo: true, callId: c.id, why: `We did this ourselves — ${actionName(c)} ran here moments ago, and this event is about the same ${shared[0].toLowerCase()}.` };
    }
  }

  return { echo: false };
}

/** "Send a message" — the action in words, for a sentence the owner reads in the history. */
function actionName(call: ToolCallRow): string {
  const body = parseServiceToolId(call.action)?.action || call.action || 'a call';
  const text = String(body).replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clip(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

function safeText(payload: any): string {
  if (payload === null || payload === undefined) return '';
  if (typeof payload === 'string') return payload;
  try { return JSON.stringify(payload); } catch { return String(payload); }
}
