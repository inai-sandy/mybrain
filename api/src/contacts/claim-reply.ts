/**
 * What the app says back when someone reports work finished. (BEA-1293)
 *
 * The owner: *"When they say it's done, you have to reply to them with which task they have
 * finished... Right now most of my team members are getting frustrated because even if they say the
 * task is done, they keep getting reminders."*
 *
 * These lines are built HERE, in code, and appended to whatever the assistant wrote — never left to
 * the model. The old behaviour had a fallback line, *"Great, thanks — noted that it's done!"*, that
 * fired whether or not anything was actually recorded. A person could not tell a working "done"
 * from one that vanished, which is precisely how the trust went.
 *
 * So the rule is narrow: this line is only ever produced when a claim really landed, and it names
 * the work it landed against. Nothing recorded → nothing said.
 */

/** Wrap a task title in quotes, trimmed to something that reads in a WhatsApp message. */
function quoted(title: string): string {
  const t = String(title || '').replace(/\s+/g, ' ').trim();
  return `"${t.length > 90 ? `${t.slice(0, 87).trim()}…` : t}"`;
}

/**
 * The confirmation for one-off work someone says they have finished.
 *
 * Says three things, all of which the person needs: WHAT was recorded, that it is with the owner
 * rather than closed, and that the nudges stop. The third is the one that was missing — the chase
 * going quiet was invisible from their side, so silence read as "ignored" and the next nudge read
 * as "you didn't listen".
 */
export function claimConfirmedLine(titles: string[]): string {
  const list = titles.map(quoted).filter((t) => t !== '""');
  if (!list.length) return '';
  const what = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  const verb = list.length === 1 ? 'it' : 'them';
  return `✅ Noted — I've marked ${what} as done and sent ${verb} to Sandeep to confirm. You won't get reminders about ${verb} meanwhile.`;
}

/**
 * Attach a system line to the assistant's own reply.
 *
 * Kept separate from the reply text the model produced so the two can never be confused, and so a
 * duplicate-reply check upstream still compares like with like.
 */
export function withSystemLine(reply: string, line: string): string {
  const r = String(reply || '').trim();
  const l = String(line || '').trim();
  if (!l) return r;
  if (!r) return l;
  return `${r}\n\n${l}`;
}

/**
 * The outgoing reply once a claim has been recorded. (BEA-1293)
 *
 * A separate function rather than three lines inside the agent, because those three lines are the
 * behaviour of the whole ticket and a test that only greps the agent for a symbol passes on the
 * import alone — which it did, and the negative control proved nothing.
 *
 * `forceSend` matters as much as the text: if the model decided to stay quiet, a landed claim
 * overrides it. Going silent on somebody's completion is exactly what lost their trust.
 */
export function replyWithClaimConfirmation(reply: string, claimedTitles: string[]): { text: string; forceSend: boolean } {
  const line = claimConfirmedLine(claimedTitles || []);
  if (!line) return { text: String(reply || '').trim(), forceSend: false };
  return { text: withSystemLine(reply, line), forceSend: true };
}
