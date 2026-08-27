# `kit` v1 — the parts box a worker stands on

This file is copied into every worker version folder next to `kit/kit.js`. It is the whole API a
worker may use. A worker has **no database, no keys and no vendor access**: every function below is
one HTTP call back into My Brain, which does the work with the job's own accounts, its credit
ceiling, its can't-undo gate and its flight recorder.

```js
import { makeKit, installDeterminism } from './kit/kit.js';
```

## Fetching

```js
await kit.fetchSource(sourceId, { pages })   // one source of the job's plan, fetched WHOLE
await kit.tool(actionId, args)               // one pinned call the plan has no source for
await kit.merge(tables)                      // several tables -> one, by the app's own merge rule
```

`fetchSource` answers

```js
{ ok: true, label: 'Instagram · Search Profiles (smart home)', credits: 3, empty: false,
  unrecognised: false, why: null, stop: null,
  table: { columns: [...], rows: [[...], ...], itemCount: 12 } }
```

- **Never page by hand.** `pages` is the plan's own number; the app runs every page, de-dupes on the
  item's own id and checks the credit ceiling before each one. A creators-first block is a source
  too — the same call runs the finder and then each creator's action.
- `empty: true` with `ok: true` is a source that genuinely had nothing (a search that answered
  "not found"). That is **not** a failure: say so in a step and carry on with the other sources.
- `unrecognised: true` is the opposite, and it matters: the calls **succeeded and carried data**, and
  no shape in the app read a single row out of it. That is our bug, never a quiet day. `kit.expect`
  knows the difference — you never have to.
- `stop` is a reason the run must end (the ceiling, a refused call). `kit.fetchSource` throws in that
  case — let it out, do not swallow it.

`merge(tables)` takes `[{ id: label, table }, …]` and answers one table with a `source` column,
de-duped across sources on the id column. With one table it answers that table. **Only sources that
brought rows go into it** — an empty source, or one whose table has 0 rows, is left out (that is
exactly what the plan runner does), and if none brought rows there is nothing to merge at all.

## Shaping and judging

```js
await kit.shape(table, { prompt, header })   // the app's own batched shaping step -> {ok, columns, rows}
await kit.ai('social-alert', prompt)         // a plain helper call (allow-listed helpers only)
```

Only shape when the plan says to. A plan whose task is "keep every result as fetched" has **no AI
step at all** — shaping it would cost tokens and change the rows.

## Calling anything, and reading the answer yourself

```js
const r = await kit.call('svc:gmail.fetch_emails', { max_results: 25 });
if (!r.ok) throw new Error(r.error);
const mails = (r.data?.messages || []).map((m) => ({ from: m.sender, subject: m.subject }));
```

### When the answer is a LIST, do not call once

```js
const r = await kit.callAll('svc:reddit.subreddit', { subreddit: 'esp32', sort: 'top', timeframe: 'week' }, { pages: 6 });
// -> { ok, count, credits, pages, table, data, empty, unrecognised }
```

`kit.call` makes exactly ONE call. For anything that comes back as a list — posts, messages, rows,
search results — that is almost never what the goal asks for. A real run asked Reddit for the top 100
posts of the week, got 6, and stopped: the answer carried `after: "t3_1vz262m"`, the cursor to the
next page, and the program never looked at it.

**`kit.callAll` is the app's own paging** — the same code that has fetched his Instagram sources for
months. It follows the vendor's cursor, de-dupes on the item's own id, stops early on a repeat or an
empty page, checks the credit ceiling before every page, and reports `count`, `pages` and `credits`
so you can check what you got against the goal BEFORE you write anything. Never write your own paging
loop; you cannot see the know-how cards that say how each vendor pages, and this can.

`kit.call(actionId, args)` reaches **any action the owner has connected** — there is no per-job
allow-list. It answers:

| field | what it is |
|---|---|
| `ok` | the call succeeded |
| `data` | **the answer the vendor really sent**, whole |
| `dataBytes` | how big it was |
| `dataTruncated` | over 2 MB, so `data` was left out — `table` still came through |
| `table` | the app's own general reading of it, `{columns, rows}` |
| `credits` | what it cost |
| `error`, `notFound` | why not, when `ok` is false |
| `droppedArgs` | argument names this action does **not** take, so they were never sent |

**Read `data` in your own code.** The app's general reader has to work for every vendor on earth and
is often wrong about a shape it has not met — `payload.headers.0.value` where you wanted `subject`,
or a single wrapped object read as a table of its own parts. When that happens, it is not something
to report and wait on: pull the fields out here, and put a test beside it using the saved answer in
`samples/`. That test is what catches the vendor moving a field next month.

**Check `droppedArgs`.** An argument the action does not take is not sent, and the call runs without
it. That is how a real build lost its Gmail limit: it passed `maxResults`, the schema calls it
`max_results`, and Gmail was asked for a whole day of mail with no cap until the vendor refused the
entire response. If something you passed comes back in `droppedArgs`, you spelled it wrong — fix it
rather than assuming it applied.

Use `r.table` when it is genuinely right — a plain list of flat items usually is. Do not use it when
it is not.

### Finding out what exists

```js
await kit.facts();                                        // every connected service
await kit.facts({ service: 'gmail', q: 'label' });         // that service's actions
await kit.facts({ actionId: 'svc:gmail.fetch_emails' });   // the whole fact card for one
```

Free — no vendor call, no credits — and deliberately **not** part of the call order, so looking
something up can never change what a replay does.

### Thinking, and researching

```js
const picked = await kit.think('Which of these matter to a founder?\n' + list, { json: true });
const report = await kit.research('What changed in EU battery rules this month?');
```

`kit.think` is a real model call (Sonnet 5, his account, tokens counted onto the run) for judgement
you cannot write as rules. `json: true` parses the reply and gives you `null` if it was not JSON, so
a bad answer is a value to check rather than a crash.

`kit.research` runs our own budgeted deep research — it plans the sub-questions, runs the searches,
reads the pages and writes a cited report. Answers `{ ok, report, spend, error }`; a failure still
reports its spend, because searches are paid for before anyone knows if the run will produce
anything.

### What still stands in your way

Almost nothing, and that is deliberate (BEA-1471 — the owner's decision, twice stated):

- there is **no credit ceiling** on a worker's calls, and **no confirmation gate**. An action that
  cannot be undone just runs. Use the right one;
- every call is written to his ledger whatever happens, so what a run did stays knowable;
- a **trial call during a BUILD** may now do anything a real run can — reads, writes and sends alike (BEA-1491, his decision). Prefer things that can be taken back, and remember a message to a person cannot be.

### Nothing is held back

The first run is REAL. There is no rehearsal and no held call: what you write is written, what you
send is sent, the first time.

Nothing here will stop you either — no confirmation gate, no spend ceiling, and no forced check
before a write. `kit.expect` is available if a row-shaped check helps, and it is entirely optional.

That puts the whole judgement on you. Check your result against the goal before you write, and if it
does not meet the goal, write nothing and say why. A run that writes an empty page and reports
success is the worst thing this program can do, and now there is nothing between you and doing it.

## Output

```js
await kit.writeSheet(table, { title, append })   // -> {ok, url, id, created, skipped, nothingNew, rows}
await kit.writeDocument({ title, markdown })     // -> {ok, docId}
await kit.notify({ whatsapp, telegram }, { headline, detail, url, title, message })
```

**`message` is the whole message the brief asked for** — as many lines as it says, written out
exactly as it should arrive. `headline` is the ONE line that rides inside the WhatsApp template.
Give both.

Why both: a WhatsApp template variable may not contain a newline, so a grouped, multi-line summary
cannot travel inside one. The template (the headline) always arrives. The full `message` follows as
a second, free-text message, which Meta delivers only while the owner's 24-hour window is open. The
run says plainly which of the two happened — never write a step that implies the full message
arrived when only the headline did.

If the brief names the exact words to send, build `message` to match them. Do not invent a summary
format of your own, and do not reduce the message to a count of rows: "finished · 5 rows" is the
exact failure this whole design exists to end.

The sheet writer is the app's: it creates the sheet, or appends under the sheet's own header and
skips rows the sheet already has. Never write the same rows twice "to be safe" — a replayed call
returns the recorded answer, and a second write with different arguments really would write twice.

## The contract — what "it worked" means

```js
const contract = JSON.parse(readFileSync(new URL('./contract.json', import.meta.url), 'utf8'));
const verdict = kit.expect(table, contract);   // -> {ok:true, rows, empty} | throws ContractError
```

`contract.json` is written by the app from the same plan this worker was compiled from. **Never edit
it.** Call `kit.expect` **before the output step, on every road**, on the very rows you are about to
write, and **let a `ContractError` out** — the kit refuses `writeSheet`, `writeDocument` and
`notify` unless the last check PASSED and it was a check of those same rows.

- `verdict.empty === true` — every source genuinely came back empty. Finish `done` with 0 rows: no
  write, no message. That is a good run.
- It **throws** `ContractError` when the rows are not what a good run looks like — too few, too many,
  a missing column, a `mustHave` column that is blank in most rows, rows older than the window, or the
  one that matters most: **0 rows out of answers that were not empty**. Let it out; the top-level
  catch turns it into `kit.fail(reason)` and nothing is written.

It is free and local: no HTTP call, no credits, and no place in the call order.

## Asking the owner, and waiting

```js
const answer = await kit.ask({
  question: 'Instagram hashtag search has failed 6 times. Carry on with creators only, or stop?',
  choices: ['Carry on', 'Stop'],   // read out to him as "reply 1, 2"
  deadlineHours: 12,               // the default; 1 … 336
  ifNoAnswer: 'Carry on',          // REQUIRED when you give choices
});

const what = await kit.trouble('Instagram has answered not_found 6 times in a row');
```

The question goes to the owner's phone on WhatsApp (template first, Meta's real verdict, Telegram if
Meta refuses) and **the worker process exits** — a two-day wait costs nothing. `kit.ask` throws
`WorkerPaused`; let it out, exactly like the shape above does. When he answers, the worker is run
again from the top, every earlier call returns its recorded answer, and `kit.ask` answers his words
at the same place in the call order.

- Answers come back as the **choice's own text** ("Carry on"), whether he replied `1` or `carry on`.
  A free-text question answers with whatever he wrote.
- After `deadlineHours` with no reply the run carries on with `ifNoAnswer` and **says so** on the run
  screen. A question with no default stops the run honestly instead — never silently.
- `kit.trouble(reason)` is `kit.ask` with the trouble said first and a safe pair of choices; its
  default when nobody answers is **Stop**, because something is already wrong.
- A **can't-undo** call (a delete, a refund) parks the run the same way, with the gate's own question.
  You do not write that code: `kit.tool(...)` throws `WorkerPaused` and the resumed call goes through
  only if he said yes.

Only ask when a wrong guess would waste the run. Every question costs the owner a message.

## Discipline

```js
await kit.step(label, status, detail)   // one readable line on the owner's run screen
await kit.checkpoint(label)             // "still moving" — not part of the call order
await kit.fail(reason)                  // end the run honestly; nothing after this runs
await kit.finish({ resultText, outputUrl, outputDocId })
kit.now(); kit.random(); kit.uuid();    // the run's frozen clock and seeded randomness
```

`status` is `done` | `failed` | `info` | `running`. Write a step for every real thing that happens:
each source fetched (with its credits), the merge, the shaping, the write, the message.

`kit.checkpoint` is how a long job proves it is alive: a run that writes no step and no checkpoint
for **20 minutes** is failed as stuck, told to the owner, and its job is freed. The app already
checkpoints inside its own loops (every page, every creator, every shaping batch), so you only need
one for milestones of your own — "4 of 9 sources done".

## The three rules a worker must never break

1. **Never invent a result.** If a call fails, say why and fail the run. A quiet success with zero
   rows is the exact bug this design exists to prevent.
2. **The call order is the identity of every call.** Every effectful call takes the next number in
   the order, whatever it answers. So the order may **never** depend on what came back: no `if
   (rows.length) await kit.step(...)` before a later fetch, no fetching in a different order on a
   retry. A worker that pauses is re-run from the top and its earlier calls return their recorded
   answers — a changed order fails loudly instead of doing a step twice.
3. **Never read the wall clock, never call a vendor, never require a package.** `kit.now()` is the
   moment the run started. There are no dependencies to install: Node 22 built-ins and `./kit/kit.js`
   only.

## The shape of `worker.mjs`

```js
import { makeKit, installDeterminism } from './kit/kit.js';

export async function run(kit) {
  // … the plan, in code. Returns a small summary object.
  return { rows: 0 };
}

// Started by the worker runner: build the kit from the environment and run once.
if (process.env.MYBRAIN_TOKEN) {
  const kit = makeKit({});
  installDeterminism(kit);
  run(kit).catch(async (e) => {
    if (e && e.paused) return;             // a question was asked; the run resumes when it is answered
    process.exitCode = 1;
    try { await kit.fail(String((e && e.message) || e)); } catch { /* already reported */ }
  });
}
```

`run(kit)` is exported so `worker.test.mjs` can drive it with a fake kit — that is how a worker is
tested against saved answers, with no app and no vendor.
