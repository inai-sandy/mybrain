import { createHash } from 'crypto';
import { ToolInfo, Turn, toolsText, transcriptText } from '../agent/goal';

/**
 * THE BUILD, standing on the conversation and the goal (BEA-1464).
 *
 * This replaces `briefText()` for any job whose owner approved a goal. What is gone is the point:
 *
 *  - **no `plan.json`** — the eight-box plan (sources · merge · shape · watch · output · notify ·
 *    schedule) was the app deciding the shape of the work before Codex ever read the conversation;
 *  - **no `contract.json`** — the app deciding what "it worked" means. The owner's instruction was
 *    explicit: *"Mainly based on a conversation, Codex has to create a goal. And it has to match the
 *    output with the goal."* The check is Codex's, derived from the goal Codex wrote;
 *  - **no `BRIEF.md`** — seven sections and tagged lines, the app's structured reading of a chat.
 *
 * What is left is what he asked for: the conversation, whole; the goal he approved; the tools he
 * named; the parts box; and real saved answers. Codex writes the program, its tests, and the check
 * that says whether a run met the goal.
 *
 * Pure — a plan, files and a prompt in, a string out. No network, no database, no disk.
 */

export type GoalBuildInputs = {
  job: { id: string; name?: string | null };
  /** The goal Codex wrote and he approved. Verbatim — never re-shaped here. */
  goal: string;
  /** The whole conversation behind it, in order, nothing removed. */
  transcript: Turn[];
  /** Only the actions he named, with whatever the catalog really knows about each. */
  tools: ToolInfo[];
  kit: { version: string; js: string; doc: string };
  /**
   * The whole document for each tool his conversation actually names (BEA-1472) — every action, with
   * its exact id. In the prompt rather than a lookup away, because a build that had to fetch it did
   * not, and pinned an action id that does not exist.
   */
  toolDocs?: { service: string; text: string }[];
  /**
   * What went wrong the LAST time this job ran (BEA-1478) — the error, and the exact arguments that
   * really reached the vendor.
   *
   * Three rebuilds in a row died on the same Gmail 413, and each time I answered by writing another
   * general note about Gmail. That was the wrong tool: the last one was not a fact about Gmail at
   * all, it was one call site in ONE program forgetting a flag. A note teaches every future agent
   * something true; it cannot see a bug in the code it is about to replace. This can.
   */
  lastFailure?: { error: string; steps: string[]; calls: { action: string; args: string; error?: string }[] } | null;
  version: number;
  previousVersion?: number | null;
  reason?: string | null;
};

/** The files that land in the worker's version folder. Deliberately few. */
export function goalBuildFiles(inp: GoalBuildInputs): Record<string, string> {
  return {
    'kit/kit.js': inp.kit.js,
    'kit/KIT.md': inp.kit.doc,
    'GOAL.md': `# The goal he approved\n\n${inp.goal}\n`,
    'conversation.md': `# The whole conversation\n\nEvery turn, in order, nothing left out.\n\n${transcriptText(inp.transcript)}\n`,
  };
}

/**
 * What Codex is asked to build.
 *
 * The tone is deliberate: it is told what the job is and then left alone. Earlier versions of this
 * prompt specified the call order, the merge step, the shaping step, which function to use for the
 * output and the exact sentence to send — and every one of those specifications produced a defect
 * that reached his phone. The only hard rules left are the two he would notice if they broke: green
 * tests before anything goes live, and never claiming something worked when it did not.
 */
export function goalBuildPrompt(inp: GoalBuildInputs): string {
  return `# Build the agent for "${inp.job.name || inp.job.id}"

You wrote the goal below and he approved it. Now build the thing that does it.

You are inside a folder (\`v${inp.version}\`) and everything you write goes here. ${inp.previousVersion ? `The job runs on v${inp.previousVersion} today, and keeps running on it until this one passes its tests.` : 'This job has no program yet.'}
${inp.reason ? `\nWhy this build: ${inp.reason}\n` : ''}
## The goal

${inp.goal}

## What to write

- **\`worker.mjs\`** — the program. It must \`export async function run(kit)\`. \`kit/KIT.md\` has the
  whole API; read it first.
- **\`worker.test.mjs\`** — its tests, run with \`node --test worker.test.mjs\`.

Nothing else is required. No plan file, no config, no contract — earlier versions of this system
handed you all three, written by the app, and each one quietly changed what he had asked for.
**The conversation and the goal are the specification.** Design the rest yourself.

## Check your own work against the goal

The goal above is not decoration. Before the program writes or sends anything, it must decide whether
what it has actually meets that goal, and **say so honestly on the run**.

You wrote the goal, so you know what a good result looks like better than any generic rule could.
Write that check in your own code, in your own terms — the number of things, their shape, their
freshness, whatever the goal actually promises. \`kit.expect(rows, contract)\` is there if a plain
row-shaped check is useful, but it is a convenience and not a requirement, and you may ignore it.

Two things matter more than the mechanism:

- **Never report success for a result that does not meet the goal.** A run that writes an empty page
  and says "done" is the worst thing this program can do. It has happened: 90 answers fetched, 0 rows
  recognised, an empty sheet written, "done" reported, 101 credits spent.
- **A genuinely empty day is not a failure.** If the goal is met by "there was nothing today", finish
  cleanly and say so plainly. Do not invent rows and do not raise an alarm.

## Talking to him

Whatever the program tells him, **you write the words** — the run's steps, the result line, and any
message he receives. Nobody templates them and there are no blanks to fill.

Two things learned from his first real message, which was wrong in both ways:

- **A count is not a summary.** "2 important emails summarised" told him nothing he wanted. The two
  summaries did. If the result is short enough to read on a phone, put it IN the message rather than
  pointing at it.
- **Never promise a link you do not have.** A line ending "Read it here:" with nothing after it is
  worse than saying nothing about links.

If the program needs a decision from him mid-run, \`kit.ask\` stops and asks — it costs nothing to
wait, the question reaches his phone, and the run resumes where it stopped when he answers.

## What you can reach

**Any action he has connected**, through \`kit.call(actionId, args)\`, which hands back \`data\` —
the answer the vendor really sent — for you to read in your own code. \`kit.facts()\` looks up
anything you do not know. \`kit.think()\` is a real model call for judgement you cannot write as
rules. \`kit.research()\` runs budgeted deep research.

**The open web, with no restriction**, both while you build and while the agent runs. Search it, read
pages, call whatever you need.

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

**Pin the exact action ids while you build.** The documents give you every id — write the ones you
chose into the program as literal strings. Do **not** write a matcher that searches action names or
descriptions at run time and picks whatever scores highest. That is not a hypothetical objection: a
build did exactly that, searched Notion for something matching "create" and "page", and picked
\`svc:notion.create_comment\` — because a Notion comment is attached to a page, so the word was in its
description. It then called it with no arguments and the run died on a missing field.

Choosing at build time is also what makes your tests real: a pinned id is a thing a test can assert,
and a matcher can only be tested against the fixture you happened to imagine.


${toolsText(inp.tools)}

${(inp.toolDocs || []).length ? `## The tools this conversation names, in full

Every action of each, with its exact id. **Take the ids you pin from here — do not type one from
memory.** A build did exactly that and pinned \`svc:whatsapp.send_message\`, which does not exist;
the real one was in the document it did not open.

${(inp.toolDocs || []).map((d) => d.text).join('\n\n---\n\n')}
` : ''}

${inp.lastFailure ? `## What happened when this last ran — read this before you write anything

The previous program failed. This is the most specific information you have about what actually
breaks, and it is about the code you are replacing.

**It said:**

${inp.lastFailure.error}

${inp.lastFailure.steps.length ? `**It got this far:**\n\n${inp.lastFailure.steps.map((x) => `- ${x}`).join('\n')}\n` : ''}
${inp.lastFailure.calls.length ? `**The arguments that really reached the vendor** — not what the program meant to send, what actually went out:

${inp.lastFailure.calls.map((c) => `- \`${c.action}\` -> \`${c.args}\`${c.error ? ` -> ${c.error}` : ''}`).join('\n')}

Compare those against what you intend to send. A flag missing from that list was never sent, whatever
the code looked like — that is exactly how the last three attempts died, and twice the program "set"
a value that never left the building.
` : ''}
` : ''}## The first run is REAL

There is no rehearsal. The first time this runs it writes what it writes and sends what it sends —
he sees the actual Notion page and the actual message, not a description of one.

So get it right rather than safe: check your own result against the goal before you write, and if it
does not meet the goal, say so and write nothing. Nothing in the app will stop you — the judgement is
yours, and it is the only one there is.

## Green tests are the only way this goes live

Run \`node --test worker.test.mjs\` yourself and fix what fails. If they cannot pass, leave them
failing and say why — the job stays on the road it is already on, and lying about it is worse than
failing.

Test the reading. The most valuable test here takes a real saved answer and asserts the fields you
pull out of it, because that is the test that catches a vendor moving a field next month.

## When you are done

Say in one short paragraph what it does, what the tests cover, what you assumed, and anything you
could not do or think is wrong with the goal. **He reads this** — it is not a log line.

## The conversation behind the goal

${transcriptText(inp.transcript)}
`;
}

/**
 * What a goal-built worker was built FROM (BEA-1464).
 *
 * The goal's version and its text, and nothing else. A plan hash would be meaningless here — there
 * is no plan — and hashing the whole conversation would mark a worker stale every time he added a
 * word to the chat without approving a new goal. Approving a NEW goal is exactly the event that
 * should mean "rebuild", and this moves precisely then.
 */
export function goalHash(version: number, text: string): string {
  return `goal:${createHash('sha256').update(`${version}|${String(text || '')}`).digest('hex')}`;
}
