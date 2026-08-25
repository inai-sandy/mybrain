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

${toolsText(inp.tools)}

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
