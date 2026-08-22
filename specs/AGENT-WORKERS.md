# Agent workers — Codex builds a small program per agent, and repairs it when it breaks

**Status: approved and being built.** Written 2026-08-22.
Owner-facing version: <https://claude.ai/code/artifact/cbbddb85-2021-40b3-9943-44a051754e16>

**Built so far**
- **1/10 — §A `ToolSample`** (BEA-1386): whole vendor answers kept, masked and gzipped.
- **2/10 — §B kit v1, §C the callback API, §H the journal** (BEA-1387): the fetch extracted into
  `SourceFetchService` and `runPlan()` switched onto it; `/api/worker/*` behind `WorkerTokenGuard`
  with per-spawn tokens; `RunJournal` with stable step keys; `AgentRun.runKind` and a `resumeTick()`
  that skips non-engine runs; frozen `Date.now`/`Math.random`/`crypto.randomUUID`; automatic
  checkpoints inside the fetch loops; the parity suite and the replay tests.
  Three deliberate differences from the sketch below, each for a stated reason:
  - **there is no `kit.creatorsFirst(find, then)`** — a creators block is fetched by its **source
    id**, like any other source. The plan already holds the block, and a worker has no database to
    describe one from;
  - **`kit.merge` has its own route** (`POST /api/worker/merge`, pure and not journalled), because
    `mergeTables()` may not be re-implemented inside a worker;
  - **`kit.expect` and `kit.watchDiff` are not built yet** — contracts are piece 6, and nothing
    dispatches a Watch on the worker road until a build turn can write one.
  The worker's clock is the moment the RUN started (journalled at `seq -1`), not the moment of the
  spawn: a question that waits two days must not move "the last 30 days" under the worker.

## The owner's words

> "The entire interview will be taken care of by Sonnet. While creating an agent, the tool will hand
> it over to Codex. Codex will create a proper agent which is a micro-service. It will use that
> micro-service whenever I want to execute."

And on maintenance:

> "If a micro-service fails, Codex will re-stitch the changes that are required."

Two reasons, both sound: **a program gives the same answer every time** (the plan-plus-model road
drifts run to run), and **repair can be automatic** — if the failure is caught and the evidence kept.

## What exists today (facts from the code, not memory)

- **There is no stored plan.** `planFromAgent()` (`api/src/social/plan.ts:190`) derives an `AgentPlan`
  fresh on every run from `Agent` columns (`tools`, `toolArgs`, `prompt`, `mode`, `outputDest`,
  `schedule`…). The only persisted copy is throwaway builder state in a `Setting` row, wiped on
  Create. `planFromAgent` ⇄ `planToAgentInput` (`agent/thinking-builder.ts:390`) are declared inverses.
- **"An agent" is `AgentArea`; the `Agent` table is a job inside it** (BEA-1095, `schema.prisma:680`,
  `:694`, linked by `Agent.areaId`).
- **The plan runner** `SocialAgentRunService.runPlan()` (`api/src/social/social-agent-run.service.ts:116`):
  credit guard before every call (fails closed) → fetch each source paged and de-duped → merge →
  shape (Sonnet, batches of 30, 32k token cap) → Sheet/Document → notify. Only two plan block kinds
  exist: `source` and `creators`; `merge`/`shape`/`watch`/`output`/`notify` are plan-level fields.
- **One recorded call site for every vendor call**: `ServiceActionsService.runDetailed()`
  (`api/src/tools/service-actions.service.ts:159`) — account resolution, the can't-undo gate
  (`GatePause` thrown, never returned), execute, credits read off the answer, a `ToolCall` row on
  every path including failure and gate-hold.
- **Codex already writes files safely on the host.** Skill turns run `codex exec -s workspace-write`
  in a throwaway folder under `$CODEX_WORKDIR/skill-ws/`, deleted on turn close
  (`services/host/codex-runner.server.js:64-81`, `:157`). Agent turns hardcode `read-only`
  (`hermes/hermes-bridge.service.ts:685`); `opts.bypass` is plumbed but no caller sets it.
- **`codex exec resume` cannot change sandbox or cwd** — it inherits the session's, so a build turn
  must be a fresh session.
- **Codex writes a `trust_level` entry into `~/.codex/config.toml` per new cwd**; the runner already
  prunes these for skill workspaces (`codex-runner.server.js:18-28`).
- **Nothing can be replayed today.** `ToolCall.result` is pretty-printed then truncated to **2000
  characters** (`service-actions.service.ts:38`, `:436`) — `ToolKnowledgeService.fieldsOfTruncated()`
  exists precisely because it bites. `SocialWatch.lastResult` degrades to key lists and hashes.
  `BuilderSampleService` keeps 3 items / 40 fields. **There is no full-payload store.**
- **One container, one process, SQLite on a named volume** (`-v mybrain-data:/app/data`). No queue, no
  concurrency cap, no leader election; ~25 bare `setInterval` timers in the single Nest process. The
  container has **no `child_process` usage at all** — every spawn lives on the host.
- **The runner speaks HTTP** on `172.18.0.1:8765` and can stream ndjson (`POST /run {stream:true}` →
  one line per `item.completed`, then a `result` line).

## Principles

1. **The plan is the brief; the worker is the build.** Sonnet interviews and produces the plan the
   owner approves. Codex compiles that plan into a program. A change of mind **re-generates** the
   worker — nobody hand-edits generated code, so what was approved and what runs cannot drift apart.
2. **A worker never holds a key and never calls a vendor directly.** It calls back into My Brain's
   tool seam with a run-scoped token, so the credit ceiling, the can't-undo gate, the `ToolCall`
   flight recorder and account resolution keep working unchanged and for free.
3. **A worker stands on a shared parts box (`kit`).** One fetcher, one sheet writer, one notifier. A
   vendor change is fixed **once, underneath**; Codex only ever re-stitches that agent's own logic.
4. **A worker must fail loudly.** It declares what a good answer looks like and checks its own output.
   Zero rows where rows were expected is a failure, never a quiet success (the BEA-1377 lesson,
   written into the architecture).
5. **A repair must prove itself.** A rewrite goes live only after passing the worker's own tests
   against **saved real answers**. Until then the last good version keeps running.
6. **Repairs are capped and never spend money.** Two attempts, always against stored samples, never
   live vendor calls. Then it stops and tells the owner.
7. **Design on Sonnet 5, delivery on Codex.** `agent-builder` stays where it is. Judgement inside a
   worker ("is this India-relevant?") stays an AI call — compiling judgement into keyword rules would
   make results worse.
8. **A worker can ask, and waiting is free.** A long job that hits trouble messages the owner on
   WhatsApp, exits, and picks up where it left off when he replies — hours or days later. This forces
   one architectural decision from the start: **every effectful call is journalled**, so replaying a
   worker never repeats work (§H). Everything else in this spec depends on that being true.

---

# The pieces, concretely

## A. `ToolSample` — keeping real answers *(prerequisite for everything)*

New Prisma model. Written from `runDetailed()` beside the `ToolCall` row, on **success only**.

```prisma
model ToolSample {
  id        String   @id @default(uuid())
  service   String                     // "instagram", "whatsapp", "googlesheets"
  action    String                     // action name, not the full svc: id
  actionId  String                     // svc:<service>.<action>, for exact lookup
  agentId   String?                    // the job this came from, null for builder/chat calls
  argsHash  String                     // sha256 of normalised args — one sample per shape
  arguments String                     // masked, uncapped (NOT redact(), see below)
  payload   Bytes                      // the WHOLE answer, masked then gzipped — BLOB, not base64
  bytes     Int                        // stored size after gzip
  kind      String   @default("good")  // "good" | "failing"
  note      String?                    // why a failing sample was kept
  createdAt DateTime @default(now())
  @@index([actionId, kind, createdAt])
  @@index([agentId])
  @@index([argsHash])
}
```

**Masking is a NEW function, not `redact()`.** `redact()` (`service-actions.service.ts:456`) cannot be
reused: it hard-truncates to `RECORDED_ARGS_CHARS = 4000` at `:465`, and it masks only by *key name*
(`/secret|token|password|api[-_]?key|credential|private[-_]?key/i`) because it was built for small
request arguments. A vendor **response** carries other people's data in innocent-looking fields —
`wa_id`, `from`, `phone`, message bodies, bios, emails. So:

- `maskPayload(value)` — new, in the sample module: no length cap; masks by key name **and** by value
  shape (e-mail, phone/E.164, long digit runs, anything matching the existing secret regex); keeps
  structure and types so a test still exercises the real shape.
- Message **content** is never sampled at all (see "never sampled" below), so the masker's job is
  metadata, not conversations.
- A sample is written only after masking; the masker is unit-tested against a fixture containing each
  personal-data shape.

Rules:
- **Caps** (one place, exported consts): `RAW_MAX = 256 KB` per payload before gzip;
  `SAMPLE_MAX_BYTES = 1 MB` stored after gzip (bigger answers are stored truncated, marked
  `usable:false` for tests); `PER_ACTION_GOOD = 5`; `PER_AGENT_FAILING = 10`; global
  `TOTAL_BUDGET_MB = 100`. Stored as a BLOB, never base64 (base64 would add ~33% to a store that the
  nightly backup copies whole).
- **Eviction**: oldest `good` sample for the same `(actionId, argsHash)` beyond `PER_ACTION_GOOD`;
  failing samples evict oldest per agent beyond `PER_AGENT_FAILING`; a nightly sweep enforces
  `TOTAL_BUDGET_MB` oldest-first, never deleting a sample a worker's `samples/index.json` references.
- **SQLite does not return deleted space to the disk by itself.** The sweep runs `PRAGMA
  incremental_vacuum` (the DB is set to `auto_vacuum=INCREMENTAL` in the same migration) so eviction
  actually shrinks the file. Without this, the logical cap does nothing to the on-disk size, and the
  nightly `.backup` + gzip (`services/backup/vps-backup-snapshot.sh:11`) grows for ever.
- **Never sampled**: Vault actions; any WhatsApp/Gmail/chat action whose answer contains message
  bodies; anything from a gated send; and any service in a new `NO_SAMPLE_SERVICES` set. Sampling is
  **opt-in per service**, starting with the social read actions the workers actually need.
- **Replay helper**: `ToolSampleService.replay(actionId, argsHash?)` returns the parsed payload for
  tests and repairs. Replay **never** touches a provider.

Acceptance: a real Instagram fetch leaves a sample whose parsed payload equals what the provider
returned (deep-equal, minus masked fields); a 3 MB answer is stored truncated and marked unusable; a
Vault action and a WhatsApp conversation read leave no sample; after evicting 50 MB the database file
on disk actually shrinks.

## B. `kit` — the shared parts box

Plain ESM JavaScript (no build step, Node 22), versioned `kit@<major>`, published to the worker
folder at build time. Every function is a thin call **back into the app** (§C), so behaviour cannot
drift from the plan runner.

```js
// fetching
await kit.fetchSource(sourceId, { pages = 1 })        // paged, de-duped on stable id → {rows, credits}
await kit.creatorsFirst(find, then, { keepDays = 30 })// profile search → per-creator posts
// shaping and judging
await kit.merge(tables)                                // mergeTables rules
await kit.shape(rows, { prompt, columns })             // batched Sonnet via completeHelper('social-shape')
await kit.judge(diff, condition)                       // Alert condition, via completeHelper('social-alert')
// output
await kit.writeSheet(rows, { sheetId, append, title })
await kit.writeDocument({ title, markdown })
await kit.notify({ whatsapp, telegram }, { headline, detail, url })
// state
await kit.watchDiff(key, rows)                         // baseline + diff, SocialWatch semantics
// discipline
kit.step(label, status, detail)                        // one readable line on the run screen
kit.expect(rows, contract)                             // throws ContractError (§E)
kit.fail(reason)                                       // ends the run honestly
```

- **Parity is by construction, not by imitation.** `kit.fetchSource` does **not** re-implement paging.
  Paging depends on `ToolKnowledgeService` cards (`social-agent-run.service.ts:324-379` reads
  `knowledge.card(id)` for `paging.field` / page size / date fields), and a worker process has no
  database. So `POST /api/worker/tool` with `{sourceId, pages}` performs the **whole paged, de-duped
  fetch server-side**, in the same extracted function `runPlan()` uses. The kit function is a thin
  call; the fetching logic exists once, in the app.
  - Build item 2 therefore includes extracting `fetchSource`/`fetchCreators` out of
    `SocialAgentRunService` into a service both roads call. `runPlan()` must be switched onto the
    extracted function in the same issue — two copies of paging is exactly the failure this design
    exists to avoid.
- **Parity is still tested**: for a fixed set of saved samples, a worker built from a plan and
  `runPlan()` on the same plan must produce **the same rows**. That suite is what lets a worker be
  trusted in place of the plan runner.
- Version pinning: `meta.json.kit = "1"`. A kit major bump never changes a running worker; it
  requires a rebuild, which re-runs the worker's tests.

## C. The callback API — how a worker reaches the app

All routes under `/api/worker`, guarded by a **run-scoped token**: minted when a run starts, bound to
`{runId, agentId, expiresAt}`, single-run, revoked at `finishRun()`. Not a user session, not an API
key, never written to the worker folder — passed in the environment of the spawned process.

| Route | Body | Does |
|---|---|---|
| `POST /api/worker/tool` | `{sourceId, pages}` or `{actionId, args}` | The **whole paged, de-duped fetch** (the extracted `fetchSource`), each page through `ServiceActionsService.runDetailed()` with `runId`, `runKind:'worker'`, `argsPinned:true`. Gate, ceiling, `ToolCall` all apply. |
| `POST /api/worker/ai` | `{helper, prompt, maxTokens}` | `llm.completeHelper(helper, …)` — helper must be in an allow-list (`social-shape`, `social-alert`). Token budget applies. |
| `POST /api/worker/step` | `{label, status, detail?, nodeId?}` | `AgentService.appendStep()` |
| `POST /api/worker/output` | `{kind, …}` | Sheet/Document write through the existing services |
| `POST /api/worker/notify` | `{whatsapp, telegram, headline, detail, url}` | `sendOwnerAlert()` — the BEA-1379 verdict + Telegram fallback applies unchanged |
| `POST /api/worker/finish` | `{status, rows, error?, contract?}` | `finishRun()`; terminal-lock semantics unchanged |

Rules:
- **A gated action parks the run the same way a question does** (§H): `runDetailed()`'s `GatePause`
  becomes `409 {gate:'held', service, action}`, the kit turns it into a waitpoint carrying "approve
  this send?", the worker exits, and the approval resumes the run — replaying the journal, so nothing
  before the gate happens twice. **It notifies on WhatsApp**, like any other worker question — note
  that the existing flow-gate precedent (`flows-runner.service.ts:955-975`) notifies Telegram and web
  push only, so this is a deliberate difference, not an inherited behaviour. **Why the journal is load-bearing and not a nicety:** the only other
  DB-durable gate pause in the codebase is `FlowRunnerService.pauseForGate()`
  (`flows/flows-runner.service.ts:955-970`), which writes `waitNodeId/waitQuestion/waitToken` onto a
  **`FlowRun`** row keyed to a live graph node — a worker has no graph and no node. And a worker is an
  imperative script: without the journal, resuming it would re-run from the top and re-fetch, re-append
  to the Sheet and re-notify. That is precisely why the direct-fetch runner fails instead of pausing
  today (CLAUDE.md: *"the direct Social runner does not catch GatePause, so a send inside a direct-fetch
  agent fails the run honestly"*). Workers may pause **only** while the journal holds.
- **Auth is a separate guard, not the session.** `AuthGuard` is a global `APP_GUARD` with two branches,
  session cookie and EMO device token (`auth/auth.guard.ts:19-52`), both granting full owner identity.
  Worker routes are marked `@Public()` to skip it and sit behind a dedicated `WorkerTokenGuard` that
  accepts **only** a run-scoped token — an owner's browser session must NOT reach these routes, or the
  "identity comes from the token" rule silently stops holding.
- Unknown helper, unknown action, expired token, or a token used for a different `runId` → `403`, and
  the run fails honestly.
- The app never trusts the worker for identity: `agentId`/`runId` come from the token, never the body.

## D. The worker folder

```
/srv/mybrain-workers/<jobId>/
  current -> v3/                 symlink; promotion is a symlink move, rollback is the same move back
  v3/
    worker.mjs                   the program Codex wrote
    worker.test.mjs              its tests, run against samples/
    contract.json                what a good answer looks like (§E)
    meta.json
    kit/                         the pinned kit copy
    samples/index.json           ids of the ToolSamples this version was tested against
  v2/ …
```

`meta.json`:
```json
{ "jobId":"…", "version":3, "kit":"1", "planHash":"sha256:…",
  "builtAt":"2026-09-04T11:22:33Z", "builtBy":"codex", "sessionId":"…",
  "tests":{"passed":7,"failed":0,"at":"…"},
  "origin":"build"|"repair", "repairOf":2, "reason":"instagram bio_links moved" }
```

`planHash` is the hash of the plan the worker was compiled from. **If the plan changes, the worker is
stale** — the UI says so and offers Rebuild; a stale worker keeps running until rebuilt (never
silently ignored, never silently used after an edit the owner expects to take effect).

## E. The contract — what "it worked" means

`contract.json`, written by Codex from the plan, rendered in plain words in the UI:

```json
{ "minRows": 1, "maxRows": 5000,
  "columns": ["creator","followers","date","link"],
  "mustHave": ["link"],
  "freshnessDays": 30,
  "allowEmptyWhen": "every source returned an empty answer" }
```

`kit.expect(rows, contract)` runs **before** the output step and throws `ContractError` with a
readable reason ("fetched 90 answers, recognised 0 rows"). `allowEmptyWhen` preserves today's
`nothingFound()` behaviour: a genuinely empty vendor answer finishes `done` with 0 rows and is **not**
a failure; recognising nothing out of a non-empty answer **is**.

## F. The worker runner — a host service

A sibling of `codex-runner`: systemd unit `mybrain-worker-runner`, HTTP on the Docker gateway
(`172.18.0.1:8766`), documented in `services/host/README.md` with the same versioned-copy discipline
(`services/host/worker-runner.server.js`).

- `POST /run {jobId, runId, token, timeoutMs}` → spawns `node <folder>/current/worker.mjs` with
  `MYBRAIN_TOKEN`, `MYBRAIN_API`, `MYBRAIN_RUN_ID` in the environment, `detached:true` so a timeout
  kills the group. Streams ndjson steps back; final line is `{type:'result', status, rows, error}`.
- Limits: default `timeoutMs = 300_000`, `--max-old-space-size=512`, no shell, cwd pinned to the
  version folder, `NODE_OPTIONS` fixed by the runner (never taken from the request).
- `POST /build {jobId, brief}` → fresh `codex exec -s workspace-write -C <folder>/vN`; runs the tests;
  returns `{ok, version, tests, log}`. Prunes `config.toml` trust entries as the skill road does.
- `GET /status` → same shape as the codex runner's, so the existing engine pill can show it.
- It **never touches the database** — everything goes through the app.
- **Port 8766 is a proposal, not a fact.** Nothing in the repo references it, but confirm with
  `ss -ltnp` on the VPS before pinning it; the runner URL is env-overridable either way.
- **The worker folders outlive the app image.** `deploy.sh` rolls back by re-tagging
  `mybrain-app:prev`, which does not touch `/srv/mybrain-workers`. A rolled-back app may therefore
  meet a worker built against a newer kit: the runner refuses to start a worker whose `meta.kit`
  major is above the app's current kit version, fails the run honestly, and the agent falls back to
  the plan runner. State this in `DEPLOY.md` too.

## G. Self-heal — the state machine

```
live(vN) ──run fails (ContractError | throw | timeout)──> capture
capture: save the failing answer as ToolSample(kind:"failing"), attach error + contract
      └─> repair(attempt 1): fresh codex session, brief = error + failing sample + contract + kit docs
            ├─ tests green ─> promote(vN+1) ─> live ─> owner told: "fixed itself, here's what changed"
            └─ not green ──> repair(attempt 2)
                  ├─ tests green ─> promote
                  └─ not green ──> STOP: agent paused (Agent.pausedReason), owner told plainly,
                                   live stays vN, no further automatic attempts
```

- **Cap is per failure cause**, not per run: the same `(jobId, contract-rule, actionId)` failure does
  not re-enter the loop once stopped; a *different* failure may.
- **Serialisation needs a lock that does not exist yet.** `AgentScheduler.tick()`
  (`hermes/agent-scheduler.service.ts:54-78`) dedups only on `lastFiredKey` (one fire per minute-slot)
  and never checks whether that agent already has a run in flight; runs are fire-and-forget promises
  with no queue. So "one repair at a time, never during a run, never a run mid-promotion" is **new
  infrastructure**: a per-job lock row (`jobId` unique, holder, takenAt, expiresAt) claimed by
  compare-and-set, released on terminal state, expiring on a timeout so a crash cannot wedge a job.
  It is its own build item, not a footnote — and it fixes an existing latent bug (two overlapping runs
  of the same job are possible today).
- A repair that changes rows on the parity suite by more than a set tolerance is **not** auto-promoted
  — it is offered to the owner instead. (Self-healing may fix plumbing; it may not quietly change what
  the agent returns.)
- **STOP and retirement are two different things, and only one is automatic.** STOP follows the one
  existing convention — `SocialBudgetService.pauseAgent()` (`social/social-budget.service.ts:79`) sets
  `pausedReason` **and** `enabled:false` — so the job genuinely stops firing and the owner is told
  what broke and what was tried. **Retirement is the owner's tap**: the notice carries "run it the old
  way instead", which clears the worker pointer and re-enables the job on the plan runner. Nothing
  silently switches roads behind the owner's back, and a paused agent is honestly paused.
- Every promotion, stop and retirement writes a line the Worker tab shows.

## H. Ask and wait — a worker can message the owner and use his answer

> Owner, 2026-08-22: *"If something goes wrong, the worker has to send a WhatsApp message, and it has
> to read my reply. There will be some big agents which take a lot of time to execute. Something is
> not working — the worker should understand, and it has to trigger a WhatsApp message."*

This is a first-class requirement, not an extra. It is also why the whole design must be **journalled
from day one** — retrofitting resume onto a script that has already fetched, written and notified is
the expensive mistake.

**What already exists (verified).** `AgentService.ask()` (`agent/agent.service.ts:918-938`) persists a
`Waitpoint` (question, kind, options, defaultValue, resumeToken, expiresAt) and sets the run to
**`awaiting_input`** (`:936` — the status set is `running | awaiting_input | scheduled | done | failed
| cancelled`, `schema.prisma:767`). It does not touch `sessionId`. Telegram answers a waitpoint by id
(`answerById`, `:948`); inbound WhatsApp lands on `contacts/postbox-callback.controller.ts`, deduped by
`wamid` (`:59`), emitting `whatsapp.reply` (`:94`).

**Three things it does NOT give us — each is new work, named here so nobody assumes otherwise:**

1. **The resume sweeper is Codex-only.** `listResumable()` (`:892-899`) looks engine-agnostic, but its
   single consumer, `HermesBridgeService.resumeTick()` (`hermes/hermes-bridge.service.ts:191-204`),
   calls `resumeRun()` (`:207-254`) which **unconditionally** builds a Codex "continue the task…"
   prompt and calls `driveTurn()` (`:253`). `AgentRun` has no `runKind`/`engine` column to branch on
   (`schema.prisma:761-783`). Following this spec naively would either strand a parked worker for ever
   (`sessionId` null → never swept) or start a **live Codex turn instead of the worker** (`sessionId`
   `''` → swept). So: **add `AgentRun.runKind`** (`'engine' | 'worker' | 'plan'`), have `resumeTick()`
   skip non-engine runs, and give the worker road its own sweeper that calls the worker runner's
   `/run` with the journal. This belongs in build item 2, beside the journal.
2. **Nothing recognises the owner's own number.** `postbox-callback.controller.ts` matches `from`
   against `Contact.whatsappNumber` (`:72-75`) and, **when nothing matches, silently returns** — so a
   message from the owner does nothing today (he is not a Contact). A new owner-number check
   (`OWNER_WHATSAPP_NUMBER` setting) runs **first**, before the Contact lookup: an owner reply with an
   open waitpoint answers it; an owner reply with none falls through untouched; a contact reply never
   reaches the waitpoint matcher. Tests must cover all three, because getting this wrong swallows
   reminder replies.
3. **`sendOwnerAlert()` knows nothing about questions.** It is fire-and-forget: two fixed templates,
   one static URL button, delivery verdict only. The question road reuses it for delivery (so the
   BEA-1379 verdict check and Telegram fallback come free) but the correlation — tag, open waitpoint,
   answer — is new plumbing on top.

### The journal — how resume does not redo work

Every kit call that costs money or has an effect is recorded against the run:

```prisma
model RunJournal {
  id        String   @id @default(uuid())
  runId     String
  seq       Int                       // call order within the run
  stepKey   String                    // sha256(seq + fn + argsHash) — stable across replays
  fn        String                    // "fetchSource" | "shape" | "writeSheet" | "notify" | "ask" | …
  result    Bytes                     // the value the call returned, gzipped
  createdAt DateTime @default(now())
  @@unique([runId, seq])
  @@index([runId])
}
```

On a resume the runner re-runs `worker.mjs` **from the top**, but every kit call first looks up its
`stepKey`: a hit returns the recorded value without touching a vendor, a sheet, or the owner's phone;
a miss executes for real and appends to the journal. So a re-run costs nothing for the part already
done, and `writeSheet(append:true)` / `notify()` cannot fire twice. This is the same idea the flow
runner already uses per node, applied to a script.

**Determinism is enforced, not hoped for.** The worker runner freezes `Date.now`, `Math.random` and
`crypto.randomUUID` in the worker's context and points them at journalled `kit.now()` / `kit.random()`.
A worker whose call order changes between replays fails loudly with "the worker is not repeatable" —
never silently doing a step twice. The build turn's tests include one replay test per worker.

### `kit.ask` — the question

```js
const answer = await kit.ask({
  question: 'Instagram hashtag search has failed 6 times. Carry on with creators only, or stop?',
  choices: ['Carry on', 'Stop', 'Retry in an hour'],   // v1: read out as "reply 1, 2 or 3"
  deadlineHours: 12,
  ifNoAnswer: 'Carry on',                              // required when choices are given
});
```

1. `POST /api/worker/ask` → `AgentService.ask()` writes the `Waitpoint`; the run goes to
   **`awaiting_input`**.
2. The question goes out on WhatsApp through `sendOwnerAlert()` — template-first, Meta's verdict
   checked, Telegram fallback if Meta refuses (BEA-1379, unchanged).
   **v1 is free text, not tappable buttons.** The stack cannot do dynamic buttons today: there is no
   `send_buttons` tool on the gateway at all, `send_list` is a *free-form* send (so it only reaches a
   recipient inside the 24-hour window — exactly what a two-day wait is outside), and the owner
   templates carry one static URL button. So a question numbers its choices and accepts `1` / `2` /
   `carry on` as the answer. **Tappable buttons are a separate later piece** needing a new
   Meta-approved quick-reply template with fixed labels ("Carry on / Stop / Later"), which is why the
   choice wording is constrained rather than free.
3. **The worker process exits.** Nothing is held open, no timeout burns, a two-day wait costs nothing.
4. The owner replies. `postbox-callback.controller.ts` matches the reply to the **oldest open
   waitpoint for the owner** before its contact/reminder handling, answers it, and the existing resume
   sweeper starts the run again.
5. The re-run replays the journal, `kit.ask` returns the answer at the same `stepKey`, and the worker
   carries on from where it was.
6. If `deadlineHours` passes with no reply, the run resumes with `ifNoAnswer` and says so in a step —
   or fails honestly when no default was given. A question is never left open for ever.

**Matching rule, stated because it will bite:** an owner reply arriving while a waitpoint is open is
treated as the answer to that waitpoint, not as a contact reply. Only one owner waitpoint may be open
at a time per run, and the outgoing message names the agent so a stale answer is obvious. If two runs
are waiting, each question carries a short tag (`#a3f`) and an untagged reply answers the oldest.

### `kit.checkpoint` and the stuck watchdog — noticing that something is wrong

Long runs must not die quietly. Yesterday's evidence: a run sat `running` for **20 hours with zero
steps** after a deploy restart and nobody was told.

- **The kit checkpoints by itself** — `fetchSource` stamps every page, `creatorsFirst` every creator,
  `shape` every batch. This is not left to whatever Codex writes, because a legitimately slow job
  (11 pages with vendor backoff, 50 sequential creator calls) must never be mistaken for a hang.
  `kit.checkpoint('fetched 4 of 9 sources')` exists on top for the worker's own milestones.
- A new watchdog (one `setInterval` beside the others) finds runs that are `running` with no step and
  no checkpoint for `STALL_MINUTES` (default 20) and: marks the run `failed` with "stopped making
  progress — nothing was written", tells the owner, and releases the per-job lock.
- A worker may also raise it itself: repeated failures from one source call
  `kit.trouble(reason, {choices})`, which is `kit.ask` with the run's context attached — this is the
  owner's "something is not working, it has to trigger a WhatsApp" case, decided by the worker rather
  than by a timer.
- The watchdog covers plan-runner runs too, so the zombie-run hole closes for both roads.

## I. Housekeeping — the things that bite in month two

- **Existing agents do not convert.** The owner's six live agents stay on the plan runner until he
  taps **Rebuild** on that job. Nothing is migrated automatically, ever. A job with no worker runs
  exactly as it does today.
- **Deleting an agent deletes its worker.** `deleteAgent` already hand-deletes `SocialWatch` rows
  because there is no FK (CLAUDE.md flags this class of bug). The same hand-kept cleanup covers
  `/srv/mybrain-workers/<jobId>/` (via the runner), the per-job lock row, `RunJournal` rows and any
  open `Waitpoint`. A test asserts nothing is left behind, because this is exactly the bug that gets
  written twice.
- **The callback token does not sleep.** It is minted per **spawn**, not per run, and revoked when the
  worker exits — including the exit into a pause. A resume mints a fresh one. So a token's life is
  minutes, never the days a question may wait.
- **A run parked across midnight gets the new day's credit ceiling** for the calls it has not made
  yet; replayed calls cost nothing because they never reach a provider. Stated so nobody "fixes" it
  later into a surprise.
- **Cost is shown per run.** Every paid call still goes through `runDetailed()` with the `runId`, so
  credits roll up exactly as they do for a plan run; the run screen and the Worker tab show credits +
  AI tokens for that run. (Today neither road displays a total — this closes it for both.)

## J. Where the owner sees it

A **Worker** row in the agent workspace (the BEA-1381 accordion): current version and when it was
built, test status, the contract in plain words, staleness ("your plan changed on 4 Sep — rebuild"),
the repair history, and **Rebuild**. Runs look exactly as they do today: readable steps, because the
worker streams them through `/api/worker/step`.

---

# Build order (issues to file after approval)

1. **Sample store** — `ToolSample`, written from `runDetailed`, redaction, caps, eviction, replay
   helper. Tests incl. "a Vault action leaves no sample" and "replay never calls a provider".
2. **`kit` v1 + the callback API + the journal** — extract `fetchSource`/`fetchCreators` into a service
   both roads call (and switch `runPlan()` onto it in the same issue); routes; `@Public()` +
   `WorkerTokenGuard` with per-spawn tokens; `RunJournal` with stable step keys; automatic
   checkpointing inside the kit's fetch/shape loops; frozen `Date.now`/`Math.random`;
   **`AgentRun.runKind`** with `resumeTick()` taught to skip non-engine runs and a worker sweeper that
   resumes through the worker runner; the **parity suite** and a **replay test** (re-running a worker
   after a pause performs zero repeat fetches, zero repeat writes, zero repeat messages).
3. **Per-job run lock** — unique lock row, compare-and-set claim, release on terminal state, timeout
   expiry; `AgentScheduler` and the repair loop both claim it. Closes the existing overlapping-run
   hole as a side effect.
4. **Worker runner** — systemd service on the host, spawn/limits/ndjson, `/status`, install + rollback
   in `services/host/README.md`. Confirm the port with `ss -ltnp` on the VPS before pinning 8766.
5. **The build turn** — plan → brief → fresh Codex session with `workspace-write`; promote only on
   green tests; honest failure when a build cannot be made; `planHash` staleness.
6. **Contracts** — `contract.json`, `kit.expect`, `allowEmptyWhen` parity with `nothingFound()`,
   plain-words rendering.
6b. **Ask and wait** — `kit.ask` / `kit.trouble` / `kit.checkpoint`; the question out through
   `sendOwnerAlert()` (template-first, Meta verdict, Telegram fallback), **free-text answers with
   numbered choices in v1**; an `OWNER_WHATSAPP_NUMBER` check inserted ahead of the Contact lookup in
   `postbox-callback.controller.ts`, matching the oldest open owner waitpoint; deadline +
   `ifNoAnswer`; the stall watchdog for both roads. Tests: a two-day wait resumes correctly; an owner
   reply with no open waitpoint changes nothing; a **contact** reply still reaches Contacts and
   Reminders untouched; a stalled run is failed and reported within `STALL_MINUTES`.
6c. **Housekeeping** (§I) — worker/lock/journal/waitpoint cleanup on agent delete, per-run cost shown
   on the run screen and Worker tab.
7. **Self-heal** — capture, repair turns, per-cause cap, promotion guard on row drift, STOP as
   `pausedReason` + `enabled:false`, owner notice, owner-tapped retirement to the plan runner.
8. **Worker tab** — version, tests, contract, staleness, repair history, Rebuild, "run it the old way";
   visual gate at 1180 + 390, light + dark.
9. **Acceptance** — rebuild "Smart Home Instagram Profiles" as a worker: same or better rows at the
   same credits as the plan run; then corrupt a saved answer to imitate a vendor change and watch it
   fail loudly, repair, pass tests and promote — **without a single vendor call**.

# Out of scope

Replacing the plan runner · hand-editing worker code in the UI · workers for other people's instances
(myemo) · a worker asking anyone **other than the owner** (a worker never messages a third party
without a gate) · Brightdata / Apify / RapidAPI, which arrive later as **new parts in the kit**,
including the "slow job" part both need (start → wait → collect).

*(Durable pause was out of scope in the first draft and is now core — see §H. The reason it is
affordable is the journal, which must therefore be built in step 2, not bolted on later.)*

# Decisions — settled by the owner, 2026-08-22

1. **Two repair attempts**, then stop and tell him. Not three.
2. **A question waits 12 hours**, then the worker takes the default it named and says so in a step.
3. **Brightdata / Apify come after this**, as new parts in the kit. RapidAPI is not integrated as a
   platform — if a specific API there proves good, it is added on its own merits.

# Risks, named

- **A worker is code we now own.** Held down by: generated from the approved plan, never hand-edited,
  tests required, kit underneath, rollback kept, retirement to the plan runner on a second failure.
- **Codex writes to disk.** Limited to that worker's version folder; no keys in the folder; the
  callback token is scoped to one run and revoked at finish; `config.toml` trust pruning as today.
- **SQLite + a second process.** The worker runner never opens the database.
- **The sample store grows the nightly backup.** `services/backup/vps-backup-snapshot.sh:11` copies and
  gzips the whole `mybrain.db` every night, and SQLite does not hand deleted space back to the disk on
  its own. Hence the 100 MB budget, BLOB not base64, and `auto_vacuum=INCREMENTAL` with an
  `incremental_vacuum` in the eviction sweep. Backup size is checked as part of build item 1's
  acceptance — this VPS has filled its disk before.
- **`redact()` is not safe for payloads** (truncates at 4000 chars, masks by key name only). A separate,
  unit-tested `maskPayload()` exists for exactly this reason; sampling is opt-in per service and no
  message content is ever stored.
- **Two roads to maintain** until every agent has a worker. Accepted deliberately — the plan runner is
  the reference the parity suite tests against.
