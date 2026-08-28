import { CHOOSE_TOOLS_RULE } from './prompt-rules';
/**
 * THE GOAL (BEA-1487) — pure functions, no Nest, no database.
 *
 * The owner's design, 2026-08-25, in his words:
 *
 *   *"With Sonnet, with the APIs, we are just using it to chat. Sonnet will not instruct anything or
 *   will not create anything. It will just send the transcription after I say ok. It will not
 *   summarize. It will not create any rough idea based on my discussion."*
 *
 *   *"We should ask codex to create a goal and send it for approval. when i approve the goal it has
 *   to create an agent and run a sample task to match the goal. verify the goal and the output."*
 *
 * What this file is, and is not:
 *
 *  - it **hands over the conversation whole**. Not a summary, not sections, not tagged lines. The
 *    only thing added is who said each turn, because a wall of undifferentiated text is not the same
 *    conversation;
 *  - it **hands over the tools he named**, and nothing else. Not the whole catalog — that was my
 *    idea and he rejected it: *"Why do you have to send the full catalog of tools? During the chat
 *    discussion I will let you know the tools that we have to send."*;
 *  - it **never writes the goal**. Codex writes it. Nothing here parses it, re-shapes it, scores it
 *    or summarises it. It is stored and shown exactly as written.
 *
 * The last point is the whole lesson of the week. Every structure the app imposed on a conversation
 * — the seven-section brief, the eight-box plan, the message template with `<holes>` — produced a
 * defect that reached his phone: a count where he wanted summaries, a link that could never be
 * filled, a sentence with no verb. The app was writing things it did not understand.
 */

/** One turn of the conversation, as the chat stored it. */
export type Turn = { who: string; text: string; at?: string; kind?: string };

/** An action he named in the chat, with what Codex needs in order to call it. */
/**
 * What ONE real call to this action just returned (BEA-1549).
 *
 * The difference between this and `sample` matters: `sample` is a REPLAYED saved answer, frozen and
 * always well-behaved. This is a live look, and it is the only place three facts can come from —
 * how many came back, whether there is another page, and whether the vendor already sorted them.
 *
 * Those three are what the ESP32 agent was rebuilt four times to learn, one run at a time.
 */
export type LiveLook = {
  count: number;
  morePages?: boolean;
  ordering?: { field: string; descending: boolean } | null;
  hasDate?: boolean;
  credits?: number;
  error?: string;
};

/**
 * The number the goal promises, if it promises one (BEA-1551).
 *
 * "the top 100 posts", "50 profiles", "20 repos" — a quantity in a goal is a promise about the WORLD,
 * and nothing ever checked it against the world. Four of his fourteen failed runs were exactly that
 * promise meeting reality at runtime: *"the goal asks for 100 posts, but Reddit returned only 71"*.
 *
 * Deliberately conservative. It reads a number that is clearly a COUNT of the thing being fetched, and
 * returns null otherwise — a wrong quantity would put a false warning in front of him, which is worse
 * than no warning at all. Years, dates and money are never counts.
 */
export function askedQuantity(goalText: string): number | null {
  const t = String(goalText || '').toLowerCase();
  // "top 100 posts" · "100 posts" · "first 50 profiles" · "latest 20 repos"
  const m = t.match(/\b(?:top|first|latest|best|newest|up to|at most)?\s*(\d{1,5})\s+(?:of\s+the\s+)?[a-z_-]{3,20}s\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 2 || n > 100000) return null;
  // A year, a price or a time is not a count of anything.
  const around = t.slice(Math.max(0, (m.index || 0) - 12), (m.index || 0) + m[0].length + 12);
  if (/\b(19|20)\d{2}\b/.test(m[1]) && /year|since|until|in \d{4}/.test(around)) return null;
  if (/[₹$€£]\s*$/.test(t.slice(0, m.index || 0))) return null;
  return n;
}

/**
 * What one real look says about a promised quantity (BEA-1551).
 *
 * Three answers, and only three, because only three are provable from one call:
 *
 *  - **impossible** — the source said there is no next page and returned fewer than promised. Then the
 *    number simply does not exist, and building a worker to chase it wastes his afternoon.
 *  - **needs paging** — more pages exist, so it is reachable but only by paging; the arithmetic is
 *    stated so nobody has to guess how deep it goes.
 *  - **fine** — one page already covers it.
 *
 * Never claims a total it has not seen. "There are more pages" is not "there are enough".
 */
export function feasibilityNote(asked: number | null, look?: LiveLook | null): string | null {
  if (!asked || !look || look.error) return null;
  const per = Number(look.count) || 0;
  if (per >= asked) return `The goal asks for ${asked}, and one page already returned ${per}. One fetch covers it.`;
  if (look.morePages === false) {
    return `**The goal asks for ${asked}, and the source has only ${per}.** It said there is no next page, so ${asked} do not exist right now. Say this in the goal — promise what is really there ("all of them, however many that is"), not a number the source cannot supply.`;
  }
  if (per > 0 && look.morePages) {
    const pages = Math.ceil(asked / per);
    return `The goal asks for ${asked} and one page returned ${per}, so this needs about ${pages} pages. There are more pages, but nothing has proved ${asked} exist — say what happens if there are fewer.`;
  }
  return null;
}

export type ToolInfo = {
  actionId: string;
  name?: string | null;
  /** The fact card, as the catalog writes it — parameters, fields, paging, cost, health, notes. */
  card?: string | null;
  /** A real answer this action gave, when one was kept. Never invented. */
  sample?: any;
  /** What ONE real call just returned (BEA-1549) — a live look, not a replay. */
  look?: LiveLook;
};

export type GoalRequest = {
  /** The whole conversation, in order, nothing removed. */
  transcript: Turn[];
  /** Only the actions he named. */
  tools: ToolInfo[];
  /** What he said when he sent a previous goal back. Absent on the first attempt. */
  sentBack?: { text: string; note: string } | null;
};

/** How a turn is labelled. Just the speaker — no interpretation of what the turn meant. */
export function speaker(who: string): string {
  return String(who || '').toLowerCase() === 'you' || String(who || '').toLowerCase() === 'owner' ? 'HIM' : 'THE ASSISTANT';
}

/**
 * The conversation, whole and in order.
 *
 * Deliberately dumb. Turns are labelled and separated and that is all — no section headings, no
 * "he decided X", no dropping of turns that look like small talk. A turn that reads as noise to a
 * summariser is exactly where a real requirement hides.
 */
export function transcriptText(turns: Turn[]): string {
  const out: string[] = [];
  for (const t of turns || []) {
    const text = String(t?.text ?? '').trim();
    if (!text) continue;
    out.push(`**${speaker(t.who)}:**`);
    out.push(text);
    out.push('');
  }
  return out.length ? out.join('\n') : '_(the conversation is empty)_';
}

/** The tools he named, each with whatever the catalog really knows about it. */
export function toolsText(tools: ToolInfo[]): string {
  // NOT "ask him which" any more (BEA-1543). He does not know the action ids, and being asked for
  // them is the thing he is tired of. When he named none, the caller hands over the actions that have
  // actually worked on his account instead — so this line is only reached when nothing has ever
  // worked, and then saying so plainly IS the honest answer.
  if (!tools?.length) return 'He named no tools, and nothing has ever run successfully on this account yet. Say plainly which part of the job you have no tool for — do not ask him to pick ids he does not know.';
  const out: string[] = [];
  for (const t of tools) {
    out.push(`### \`${t.actionId}\`${t.name ? ` — ${t.name}` : ''}`);
    out.push('');
    out.push(t.card ? String(t.card) : '_(no fact card is available for this action — call it and see, or ask him.)_');
    // THE LIVE LOOK COMES FIRST (BEA-1549). A replayed sample is frozen and always well-behaved; one
    // real call is the only thing that can say how many exist, whether there is another page, and
    // whether the vendor already sorted them. Those three facts are what four rebuilds of his ESP32
    // agent went to learn, one live run at a time.
    if (t.look) {
      const l = t.look;
      if (l.error) {
        out.push('', `**A real call just now FAILED:** ${l.error} — plan for this being unavailable, and say so.`);
      } else {
        const bits: string[] = [`came back with **${l.count}** item${l.count === 1 ? '' : 's'} on one page`];
        bits.push(l.morePages ? 'and there **are more pages** after it' : 'and there was **no next page** — that was everything it has');
        bits.push(l.ordering
          ? `already sorted by \`${l.ordering.field}\`, ${l.ordering.descending ? 'highest first' : 'lowest first'}`
          : '**not in any order you can rely on** — sort what you fetch yourself');
        if (l.hasDate !== undefined) bits.push(l.hasDate ? 'items carry a date' : 'items carry **no date**, so "the last N days" cannot be filtered here');
        out.push('', `**One real call just now:** ${bits.join('; ')}.`);
      }
    }
    if (t.sample !== undefined && t.sample !== null) {
      let json = '';
      try { json = JSON.stringify(t.sample, null, 2).slice(0, 4000); } catch { json = ''; }
      if (json) {
        out.push('', 'A real answer this action gave (masked where it carried anything personal):', '', '```json', json, '```');
      }
    }
    out.push('');
  }
  return out.join('\n');
}

/**
 * What Codex is asked, at the goal step. It writes ONE thing: the goal, for him to approve.
 *
 * It is told plainly that nobody has interpreted the conversation for it, and that it may ask him
 * rather than guess — because guessing is what produced every defect so far, and a question costs a
 * minute where a wrong assumption costs a rebuild.
 */
/**
 * The promised number, checked against what the real look found (BEA-1551).
 *
 * Empty when the goal names no quantity, or when no look could be taken — an unchecked promise is
 * quieter than a wrong warning.
 */
export function quantityText(req: GoalRequest): string {
  const asked = askedQuantity(goalAsk(req));
  if (!asked) return '';
  const notes: string[] = [];
  for (const t of req.tools || []) {
    const n = feasibilityNote(asked, t.look);
    if (n) notes.push(`- \`${t.actionId}\` — ${n}`);
  }
  if (!notes.length) return '';
  return [
    '',
    '## The number this goal promises',
    '',
    'He asked for a specific amount. One real call was made to check it against what the source actually holds:',
    '',
    ...notes,
    '',
    'Say the truth of this **in the goal he approves**, in his own plain words — he should never approve a number that cannot be delivered, and should never be surprised at the first run. If the amount is not there, promise what is ("everything there is, however many that turns out to be").',
  ].join('\n');
}

/** His own words — the last thing he said, which is what the number was asked in. */
function goalAsk(req: GoalRequest): string {
  const turns = Array.isArray(req.transcript) ? req.transcript : [];
  return turns.map((t: any) => String(t?.text || '')).join(' ');
}

export function goalPrompt(req: GoalRequest): string {
  return `# Read this conversation and tell him what you are going to build

Below is a conversation between the owner of My Brain and an assistant, whole and unedited. He wants
an agent built from it.

**Nobody has interpreted it for you.** There is no brief, no plan, no summary and no form — earlier
versions of this system had all of those, and every one of them quietly changed what he asked for.
The conversation is the requirement. Read all of it, including the parts that look like small talk.

## What to write

**One thing: the goal.** In plain English, what this agent is for — what it will do, what it will
produce, when it runs, and how he will know it worked. Write it for HIM to read and approve, not for
a machine to parse. No headings you do not need, no JSON, no checklist unless a checklist is
genuinely the clearest way to say it.

Be specific enough that, later, you could hold a real run's output next to this and say honestly
whether it did the job. That is exactly what will happen: you will run it once and check it against
this goal.

**Where the conversation is unclear, say so in the goal** — name the assumption you are making, in
his words, so he can correct it when he reads it. Do not quietly pick one reading. If something is
important enough that guessing it would waste the build, ask him instead: reply with a question and
nothing else, and he will answer.

**Do not write any code yet.** Not a plan, not a file, not a design. Only the goal. He approves it
first, and then you build.

${req.sentBack ? `## He sent your last goal back

You wrote:

${req.sentBack.text}

He said:

> ${req.sentBack.note}

Take that seriously — it is the most direct information you have. Write the goal again.

` : ''}## The tools he named

These are the actions he said to use. He chose them; you do not have to justify them, but if one
cannot do what the conversation needs, say so in the goal rather than working around it silently.

${toolsText(req.tools)}
${quantityText(req)}

You also have the open web while you build and while the agent runs — search it, read pages, call
whatever you need. Nothing is blocked.

## Choose the tools yourself
These are connected and working — what has actually succeeded on his account, most-used first.
${CHOOSE_TOOLS_RULE}

## Look the tools up — do not guess

You have three lookups, and they cost nothing:

- **\`list_tools\`** — every tool the owner has connected, with how many actions each has. Start here.
- **\`tool_doc(service)\`** — one tool's whole document: what it is, and EVERY action it has, with the
  exact id of each.
- **\`action_doc(actionId)\`** — one action in full: its exact parameters, the fields real answers have
  carried, what it has cost, whether it is failing right now, and any trap recorded about it.

**Use them before choosing an action, and again before calling one you have not called before.**
Guessing a service name or a parameter is the most common way this produces a program that runs and
returns nothing. It has already happened once: a build was handed no tool information at all, wrote a
program that could not find Gmail, and the owner lost an hour to it.

If something the work needs is **not connected**, the documents say so. Say that plainly rather than
working around it — he would rather connect it than receive an agent that quietly does less.

**And try them.** \`try_action(actionId, args)\` makes a REAL read against his actual account and shows
you the real answer. **Use it before you write a call you have not made before.** Not the schema, not
the example in the card — the thing itself, from his account, right now.

That is how you find out what no document can tell you: what the fields are really called in HIS
data, how big the answer really is, whether the account is even set up for what the goal wants.

It is reads only — an action that changes something is refused, and you write that one from its card.
You get 25 tries per build. Spend them: a build that guesses costs him an evening, and a build that
looks costs a minute.

Every failure this system has had came from a program written blind and finding out in production.
You do not have to work blind any more.

**A confirmed action is a usable action.** Some actions cannot be undone — sending a message, deleting
something — so the owner is asked before they run. That is a pause, not a refusal: the run stops, the
question reaches his phone, he answers, and it carries on. **Never treat one as unavailable, never
look for a way around it, and never leave the step out.** The first real build did exactly that: it
saw WhatsApp's send marked as needing confirmation, decided there was no "safe" action, and failed
the whole run — with the action it needed listed right in front of it.


## The conversation

${transcriptText(req.transcript)}
`;
}

/**
 * Codex answered. Is that a goal, or is it a question for him?
 *
 * The prompt tells it that a question may be the whole reply, so this is the only reading done on
 * the answer — and it is a routing decision, not an interpretation. Everything else is stored and
 * shown exactly as written.
 *
 * The test is deliberately narrow: a short reply that ends in a question mark and has no paragraphs
 * is a question. A long answer that happens to contain a rhetorical question is a goal. Getting this
 * wrong in the safe direction shows him a goal he can send back, which costs one tap; getting it
 * wrong the other way would hide a real question behind a wall of text.
 */
export function isQuestion(reply: string): boolean {
  const t = String(reply || '').trim();
  if (!t) return false;
  if (t.length > 600) return false;
  if (t.split(/\n\s*\n/).length > 2) return false;
  return t.endsWith('?');
}

/** Nothing usable came back. Said in his words, because he is the one who reads it. */
export function nothingCameBack(reply: string): string | null {
  return String(reply || '').trim() ? null : 'Codex did not answer when asked to write the goal. Nothing has been built. Try again, or tell me what changed.';
}

/**
 * When should this agent run? (BEA-1482)
 *
 * Asked of CODEX, not worked out here. The goal is free text by the owner's own design — "It will
 * not create any rough idea based on my discussion" — so the app parsing "every day at 22:00" out of
 * a paragraph would be exactly the interpreting he removed. Codex wrote the goal; Codex says what
 * the timing in it means.
 *
 * It matters because without it an agent is kept, switched on, and never fires. That happened: his
 * first working agent had to have its schedule set by hand after the fact.
 */
export function schedulePrompt(goal: string): string {
  return `Below is the goal you wrote for an agent. Say WHEN it should run.

Reply with ONLY a JSON object, no prose:

{"every":"day"|"weekday"|"week"|"hour"|"none","at":"HH:MM","dow":0-6,"text":"every day at 22:00"}

- \`at\` is 24-hour local time. \`dow\` only for "week" (0 = Sunday).
- \`"none"\` means the goal does not say when — he will run it himself. Do NOT invent a time.
- \`text\` is the plain sentence he will read on the screen.

THE GOAL:

${goal}
`;
}

/** Read the schedule reply. Anything unreadable means "he never said", never a guessed time. */
export function readSchedule(reply: string): { schedule: string | null; text: string } {
  const t = String(reply || '').replace(/^\s*\`\`\`(?:json)?\s*|\s*\`\`\`\s*$/g, '').trim();
  let j: any = null;
  try { j = JSON.parse(t); } catch { return { schedule: null, text: '' }; }
  const every = String(j?.every || '').toLowerCase();
  if (!['day', 'weekday', 'week', 'hour'].includes(every)) return { schedule: null, text: '' };
  const at = /^\d{1,2}:\d{2}$/.test(String(j?.at || '')) ? String(j.at).padStart(5, '0') : undefined;
  if (every !== 'hour' && !at) return { schedule: null, text: '' }; // a daily schedule with no time is not a schedule
  const dow = Number.isInteger(j?.dow) && j.dow >= 0 && j.dow <= 6 ? j.dow : undefined;
  return {
    schedule: JSON.stringify({ every, ...(at ? { at } : {}), ...(every === 'week' && dow !== undefined ? { dow } : {}) }),
    text: String(j?.text || '').trim().slice(0, 120),
  };
}
