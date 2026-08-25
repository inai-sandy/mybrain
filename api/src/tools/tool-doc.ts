import { createHash } from 'crypto';

/**
 * ONE DOCUMENT PER TOOL (BEA-1468) — pure text building, no Nest, no database, no network.
 *
 * The owner, 2026-08-25: *"We have to create tool details individually and store them in a document.
 * Each tool should have a document. Based on the requirement, Codex has to pull the tool information
 * and actions information to create an agent… If the context is not proper, it cannot create the
 * right agent that we are looking for."*
 *
 * That last sentence is the design brief. Two failures this week came from thin context, not from a
 * weak model: Codex was handed an empty tool list and its program could not find Gmail, and before
 * that a card-shortlist I picked left out the very action the job needed. So a tool's document lists
 * **every** action it has — not a selection — and says honestly where each fact came from.
 *
 * The shape is deliberately two-level, and that is the one judgement in this file. A service can
 * have 823 actions; writing every parameter of every one produces a document no reader can hold in
 * context, which fails the owner's own test in a new way. So the document is a complete INDEX — every
 * action, its exact id, and what it does — and full detail is a second, cheap lookup on the one
 * action Codex has chosen. Nothing is hidden; it is paged.
 */

export type DocAction = {
  /** `svc:<service>.<action>` — the exact string a program must call. */
  id: string;
  name: string;
  description?: string | null;
  /** True when this one stops and asks the owner before it runs (a can't-be-undone action). */
  risky?: boolean;
  /** The vendor has retired it. Kept and marked, never dropped — the owner's rule. */
  retired?: boolean;
  /** GET/POST as the vendor declares it; a read is never gated. */
  method?: string | null;
};

export type DocInputs = {
  service: string;
  name: string;
  /** What the catalog says this service is. */
  about?: string | null;
  connected: boolean;
  actions: DocAction[];
};

/**
 * One line of the index. The id first, because the id is the thing a program actually needs.
 *
 * The tag for a gated action says **he confirms it**, not "asks first" (BEA-1469). The difference is
 * not cosmetic: the first real build read "(asks first)" as a warning, decided WhatsApp had no "safe
 * matching action", and failed the whole run — while the document listed `svc:whatsapp.send_text`
 * right there and the header explained that a gate is a pause, not a refusal. A header read once
 * cannot outweigh a warning attached to the very line where the choice is made.
 */
function line(a: DocAction): string {
  const tags = [a.risky ? '**he confirms it** — usable' : '', a.retired ? '_retired_' : ''].filter(Boolean).join(' · ');
  const what = String(a.description || a.name || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  return `- \`${a.id}\` — ${what || a.name}${tags ? ` (${tags})` : ''}`;
}

/**
 * The document for one tool: what it is, and every action it has.
 *
 * Written for a reader who has to choose an action and then call it correctly, so the id is always
 * first and the prose is always second.
 */
export function toolDocText(inp: DocInputs): string {
  const live = inp.actions.filter((a) => !a.retired);
  const retired = inp.actions.filter((a) => a.retired);
  const risky = live.filter((a) => a.risky);

  const out: string[] = [];
  out.push(`# ${inp.name || inp.service}`);
  out.push('');
  out.push(`Service id: \`${inp.service}\``);
  out.push(inp.connected ? 'The owner has connected this. Its actions can be called.' : '**Not connected.** Its actions cannot be called until the owner connects it in /tools.');
  if (inp.about) out.push('', String(inp.about).trim());
  out.push('');
  out.push(`It has **${inp.actions.length} action${inp.actions.length === 1 ? '' : 's'}**${retired.length ? ` (${retired.length} retired)` : ''}. Every one is listed below — this is the whole list, not a selection.`);

  if (risky.length) {
    out.push('');
    out.push(`**${risky.length} of them cannot be undone**, so the owner confirms them before they run. That is a pause, not a refusal: the run stops, the question reaches his phone, he answers, and it carries on exactly where it was.`);
    out.push('');
    out.push('**Use them normally.** A confirmed action is not unavailable, is not unsafe, and is not a reason to look for an alternative or to leave a step out. If the work needs one, use it — he expects to be asked. Reads are never gated at all.');
  }

  out.push('');
  out.push('## Every action');
  out.push('');
  if (live.length) for (const a of live) out.push(line(a));
  else out.push('_(none)_');

  if (retired.length) {
    out.push('');
    out.push('### Retired by the vendor');
    out.push('');
    out.push('Still callable, and still listed because the owner asked that no action ever be hidden — but prefer a live one.');
    out.push('');
    for (const a of retired) out.push(line(a));
  }

  out.push('');
  out.push('## Getting the detail of one');
  out.push('');
  out.push('This is the index. For the exact parameters an action takes, the fields its answer really');
  out.push('carries, what it has cost, whether it is failing right now, and any trap somebody has');
  out.push('written down about it, ask for that one action by its id. Do that before calling anything');
  out.push('you have not called before — guessing a parameter name is the most common way a build');
  out.push('produces a program that runs and returns nothing.');
  out.push('');
  return out.join('\n');
}

/** Of the document's own text, so a rebuild that changes nothing leaves the row alone. */
export function docHash(text: string): string {
  return createHash('sha256').update(String(text || '')).digest('hex').slice(0, 16);
}

/**
 * The index Codex is given when it asks what exists at all.
 *
 * Every connected tool, with its action count, so it can tell "this service has nothing useful" from
 * "I have not looked yet". Not connected services are named too, because "Notion is not connected"
 * is exactly the answer that would have saved his first real run.
 */
export function toolIndexText(docs: { service: string; name: string; actions: number; connected?: boolean }[]): string {
  if (!docs.length) return 'No tools are connected yet. The owner connects them in /tools.';
  const on = docs.filter((d) => d.connected !== false);
  const off = docs.filter((d) => d.connected === false);
  const out: string[] = ['# The tools available', ''];
  out.push('Ask for any of these by its service id to get its document — what it is, and every action it has.');
  out.push('');
  for (const d of on) out.push(`- \`${d.service}\` — ${d.name} · ${d.actions} action${d.actions === 1 ? '' : 's'}`);
  if (off.length) {
    out.push('', '## Not connected', '', 'These exist but cannot be called until the owner connects them. If the work needs one, say so rather than working around it.', '');
    for (const d of off) out.push(`- \`${d.service}\` — ${d.name}`);
  }
  return out.join('\n');
}

/**
 * Which tools does this conversation actually talk about? (BEA-1472)
 *
 * A plain string match of every known service slug and name against the goal and the conversation.
 * No interpretation: "notion" appears in his words, so Notion's document is worth putting in front of
 * Codex. It is not deciding anything — the full lookup is still there for everything else.
 *
 * This exists because of a real failure. He named no tools in the chat, so Codex had to discover
 * them; it was told to pin exact ids, and it pinned `svc:whatsapp.send_message` — which does not
 * exist. The document listing `svc:whatsapp.send_text` was one lookup away and it did not make it.
 * Putting the document in the prompt removes the round-trip it skipped.
 */
export function toolsNamedIn(text: string, known: { service: string; name: string }[]): string[] {
  const hay = ` ${String(text || '').toLowerCase()} `;
  const out: string[] = [];
  for (const k of known || []) {
    const slug = String(k.service || '').toLowerCase();
    const name = String(k.name || '').toLowerCase();
    if (!slug) continue;
    // Whole words only — "notion" must not match inside "notional", and a two-letter slug must not
    // match half the sentence.
    const hit = [slug, name].filter(Boolean).some((w) => w.length >= 3 && new RegExp(`[^a-z0-9]${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^a-z0-9]`).test(hay));
    if (hit) out.push(slug);
  }
  return [...new Set(out)];
}
