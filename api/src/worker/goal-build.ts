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
  /**
   * The owner's own timezone (BEA-1486) — `Asia/Kolkata` for him.
   *
   * The server runs on UTC and the prompt never mentioned time zones at all, so every program was
   * written against UTC and was five and a half hours out of step with his day. "Every day at 22:00"
   * meant nothing until somebody said whose 22:00.
   */
  timezone?: string | null;
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

## When something surprises you, ASK him — do not stop

His instruction, after a run died on its last step: *"It should ask me rather than stop it."*

\`kit.ask\` reaches his phone, **the worker exits while it waits** (a two-day wait costs nothing),
and when he answers the run starts again from the top with every earlier call returning its recorded
answer — no repeated fetch, no repeated write, no repeated message. Waiting is free. Giving up is not.

So the order to try is always:

1. **Work it out yourself first.** If the answer is somewhere in what you already have, or one
   \`kit.facts()\` lookup away, find it. Never ask him something the program could read.
2. **If you cannot, ask him** — especially once the run has already changed something in the world.
   A run that creates his page and then dies leaves him with a half-finished thing and no idea what
   happened. Ask what to do with it.
3. **\`kit.fail\` is the last resort**, for when there is genuinely nothing he could say that would
   help. If you can think of a question worth asking, it was not the last resort.

This really happened, and it is the shape to avoid: the program created his Notion page, could not
find the page id in the answer, and stopped — reporting failure for a page that existed. The right
move was either to read the answer properly, or to ask him: *"I made the page but cannot find its
link. Shall I send you the title, or do you want to paste the link?"*

Ask in his words, offer real choices, and give \`ifNoAnswer\` when a sensible default exists.

## What you can reach

**Any action he has connected**, through \`kit.call(actionId, args)\`, which hands back \`data\` —
the answer the vendor really sent — for you to read in your own code.

**Read \`data\` defensively: some actions wrap their answer in an envelope and some do not**, and it
is not consistent between services. Gmail answers \`{ messages: [...] }\` with the payload at the top
level; Notion's create-page answers \`{ data: { id, url, ... } }\` with everything one level down. A
reader written for one shape silently finds nothing in the other — that exact mismatch made a run
report "Notion did not return a page id" about a page it had just created successfully. So unwrap
before you read (\`const body = answer?.data ?? answer;\`), look under both, and when a field you
need is genuinely missing, say which shape you actually got. \`kit.facts()\` looks up
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

${inp.timezone ? `## His clock

He is in **${inp.timezone}**. This server runs on UTC, which is a different time — so \`new Date()\`
in your program is NOT his time.

Every time in the goal is HIS time: "22:00" is 22:00 where he is, "today" is today where he is, and
"the last 24 hours" ends now, where he is. Compute dates and windows in \`${inp.timezone}\` — for
example \`new Intl.DateTimeFormat('en-CA', { timeZone: '${inp.timezone}' }).format(new Date())\` gives
his date as YYYY-MM-DD. A page titled with the server's date will be wrong for him for part of every
day, and he will not know why.

` : ''}## Trying a call now includes writes — his decision, and it is yours to use well

Trials used to be reads only, and that was the reason four builds in a row failed: every one of them
failed on a **write** whose shape had to be guessed from a description. That restriction is gone. You
can try **any** call while you build — create the page, add the content, write the sheet — and see the
vendor's real answer instead of hoping.

Nothing will stop you, so the judgement is yours. Two things worth knowing while you use it:

- **Prefer things that can be taken back.** Create a throwaway page and archive it; write to a scratch
  row. That way trying costs nothing but the call.
- **A message to a person cannot be taken back.** A trial send really reaches a real phone, and the
  person on the other end did not ask to be part of a build. If you need to prove a send works, prefer
  the owner's own number, send one, and say on the run that you did.
- **Clean up after yourself.** Deleting and archiving work in a trial too, so a test page you made is
  yours to remove. Leaving litter in his Notion or his Drive is not a small thing — he has to tidy it
  by hand, and he cannot tell your test items from his own.

Use it properly and you will not have to guess a shape again.

## You have no plan — never call \`kit.fetchSource\`

This job is built from a goal, not a plan, so it has **no sources**. \`kit.fetchSource(sourceId)\` can
only ever answer *"This job has no source called …"* and fail the run. A real repair reached for it
and broke a working agent that way.

Everything you fetch is by ACTION ID: \`kit.call\` for one call, \`kit.callAll\` for a list.

## A list is never one call

If the goal asks for a NUMBER of things — 100 posts, every message this week, all the rows — one call
will not get them, and no amount of arguments will change that. Vendors hand back one page and a
cursor to the next.

Use \`kit.callAll(actionId, args, { pages })\`. That is the app's own paging: it follows the vendor's
cursor, de-dupes on the item's own id, stops early on a repeat or an empty page, and reports
\`count\`, \`pages\` and \`credits\` back to you. **Never write a paging loop yourself** — the app can
see the know-how card that says how this particular vendor pages, and your program cannot.

This is not hypothetical. A real agent asked Reddit for the top 100 posts of the week with
\`{ subreddit, sort }\` — no time filter, one call — got 6 posts, and stopped. The answer it received
contained \`after: "t3_1vz262m"\`, the cursor to the next page, and the action's own card said
"paging: cursor via after". Every fact was in front of it. One call was still the wrong shape.

And check the count against the goal BEFORE you write anything: 6 of 100 is not a small sheet, it is
a fetch that did not finish.

## "Everything there was" is not the same as "not enough"

When a fetch comes up short of what the goal asks for, there are two completely different reasons and
they deserve different answers:

- **The fetch did not finish** — a page failed, the cap was hit, a cursor was missed. That is a
  failure. Say so and write nothing.
- **The vendor gave everything it had.** \`kit.callAll\` tells you: its step says *"that was
  everything"* and \`pages\` is less than you allowed. The goal is simply asking for more than exists
  this time.

The second is **not a bug and not a failure** — it is a question only he can answer. A real run asked
for the top 100 posts of a week, fetched all 5 pages, got the 90 that existed, and failed the run.
Nothing was wrong: that subreddit had 90 posts that week.

So when the source is exhausted and you are still short, **ask him** (\`kit.ask\`) — "Reddit had only
90 this week, not 100. Write those, or stop?" — with a sensible \`ifNoAnswer\`. Do not fail, and do not
quietly write 90 as though it were 100 either: say the real number in the message and on the run.

## Do not filter twice and then check the counts match

A real failure of his, worth not repeating: the program chose 6 important emails, handed them to the
model with the instruction *"do not include newsletters or low-priority items"* — asking it to filter
what had **already** been filtered — and then failed its own check because 6 selected did not equal 3
summarised. It filtered, asked for another filter, then asserted nothing had been filtered.

Decide **once** where a judgement happens. If your code has already chosen the items, the model's job
is to describe every one of them and say so plainly: "write two lines for EACH of these; do not leave
any out." If the model is the one choosing, then your code must not assert a count it did not decide.

The same goes for anything that drops rows quietly. If you match the model's answers back to your
items by id, an answer whose id you cannot find must be **reported**, not silently discarded — a
\`.filter(Boolean)\` that removes three of six is the bug you will spend a day looking for.

## Try every call before you write it — this is a step, not an option

For each action you are going to use, call \`try_action\` **once**, with roughly the arguments you
intend to send, and look at what comes back. Then write the call from what you saw.

This is not caution, it is the difference between working and not. A build with this exact ability
skipped it and guessed three spellings of one Notion argument — \`parent_page_id\`, \`parent page id\`,
\`parent\` — when the real name was \`parent_id\`. All three were dropped, the call failed, and the
owner lost another round. One try_action would have shown it in ten seconds.

**Never send several spellings of the same argument hoping one lands.** An argument this system does
not recognise is silently dropped, so a shotgun is indistinguishable from sending nothing. Try it,
read \`droppedArgs\` in the answer, and use the name that actually survived.

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
