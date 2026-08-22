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
  why: null, stop: null, table: { columns: [...], rows: [[...], ...], itemCount: 12 } }
```

- **Never page by hand.** `pages` is the plan's own number; the app runs every page, de-dupes on the
  item's own id and checks the credit ceiling before each one. A creators-first block is a source
  too — the same call runs the finder and then each creator's action.
- `empty: true` with `ok: true` is a source that genuinely had nothing (a search that answered
  "not found"). That is **not** a failure: say so in a step and carry on with the other sources.
- `stop` is a reason the run must end (the ceiling, a refused call). `kit.fetchSource` throws in that
  case — let it out, do not swallow it.

`merge(tables)` takes `[{ id: label, table }, …]` and answers one table with a `source` column,
de-duped across sources on the id column. With one table it answers that table.

## Shaping and judging

```js
await kit.shape(table, { prompt, header })   // the app's own batched shaping step -> {ok, columns, rows}
await kit.ai('social-alert', prompt)         // a plain helper call (allow-listed helpers only)
```

Only shape when the plan says to. A plan whose task is "keep every result as fetched" has **no AI
step at all** — shaping it would cost tokens and change the rows.

## Output

```js
await kit.writeSheet(table, { title, append })   // -> {ok, url, id, created, skipped, nothingNew, rows}
await kit.writeDocument({ title, markdown })     // -> {ok, docId}
await kit.notify({ whatsapp, telegram }, { headline, detail, url, title })
```

The sheet writer is the app's: it creates the sheet, or appends under the sheet's own header and
skips rows the sheet already has. Never write the same rows twice "to be safe" — a replayed call
returns the recorded answer, and a second write with different arguments really would write twice.

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
