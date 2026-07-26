/**
 * Which email senders the brain will remember (BEA-1125 / BEA-1126).
 *
 * Email was the single biggest thing in the brain — 600 of 1,326 items — and the only gate was
 * Gmail's own "important" flag, so Google decided what got remembered. One machine sender alone
 * (`noreply@communication.feturtles.com`) accounted for 66 of them, more than any real colleague.
 *
 * The owner's rule: important mail from real people must be kept, but **if a human cannot receive
 * a reply, the brain should not keep it.** These helpers are pure so the rule can be tested against
 * his real sender list without touching the store.
 */

/** Local-parts that mean "nobody is reading replies to this". */
const NO_REPLY_LOCAL = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|mailer-?daemon|bounces?|postmaster)([._+-]|$)/i;

/** Pull the bare address out of a From header: `"Airtel IoT" <m2m_info@airtel.com>` → the address. */
export function senderAddress(from?: string | null): string {
  const raw = String(from || '').trim();
  const angled = /<([^>]+)>/.exec(raw);
  return (angled ? angled[1] : raw).toLowerCase().trim();
}

/** Just the part before the @ — what the no-reply rule looks at. */
export function senderLocalPart(from?: string | null): string {
  const addr = senderAddress(from);
  const at = addr.indexOf('@');
  return at > 0 ? addr.slice(0, at) : addr;
}

/**
 * Is this a machine address nobody can reply to? Deliberately matches the LOCAL PART only —
 * a domain like `no-reply.example.com` still belongs to a real person's mailbox, and a rule that
 * scanned the whole address would quietly drop real colleagues.
 */
export function isNoReplySender(from?: string | null): boolean {
  const local = senderLocalPart(from);
  return !!local && NO_REPLY_LOCAL.test(local);
}

/**
 * Should this email be kept out of the brain? Either the automatic no-reply rule, or the owner has
 * blocked that exact address by hand. Blocking is per-address, never per-domain: `hr@kiot.io` and
 * `noreply@kiot.io` must be able to disagree.
 */
export function isBlockedSender(from: string | null | undefined, blocked: Iterable<string> = []): boolean {
  if (isNoReplySender(from)) return true;
  const addr = senderAddress(from);
  if (!addr) return false;
  for (const b of blocked) {
    if (senderAddress(b) === addr) return true;
  }
  return false;
}
