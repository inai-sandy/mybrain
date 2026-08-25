/**
 * THE GOAL (BEA-1463) — pure functions, no Nest, no database.
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
export type ToolInfo = {
  actionId: string;
  name?: string | null;
  /** The fact card, as the catalog writes it — parameters, fields, paging, cost, health, notes. */
  card?: string | null;
  /** A real answer this action gave, when one was kept. Never invented. */
  sample?: any;
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
  if (!tools?.length) return 'He did not name any tools in the conversation. If the work needs one, ask him which — do not guess.';
  const out: string[] = [];
  for (const t of tools) {
    out.push(`### \`${t.actionId}\`${t.name ? ` — ${t.name}` : ''}`);
    out.push('');
    out.push(t.card ? String(t.card) : '_(no fact card is available for this action — call it and see, or ask him.)_');
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

You also have the open web while you build and while the agent runs — search it, read pages, call
whatever you need. Nothing is blocked.

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
