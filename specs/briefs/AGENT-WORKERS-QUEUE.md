# Agent workers — the build queue (pieces 2–10)

Design: `specs/AGENT-WORKERS.md`. Owner plan:
<https://claude.ai/code/artifact/cbbddb85-2021-40b3-9943-44a051754e16>
Piece 1 has its own brief: `AGENT-WORKERS-1-toolsample.md` (in build).

Owner's settled decisions (2026-08-22): **two** repair attempts · a question waits **12 hours** then
takes its stated default · **Brightdata/Apify come after** this whole run.

Linear was logged out when this queue was written, so these are the briefs to file as issues when it
is back. One piece at a time, in this order — each assumes the ones above it are live.

---

## 2 — `kit` v1, the callback API, and the journal  *(§B, §C, §H journal)*

The biggest piece, and the one that decides whether everything else works.

**Build**
- **Extract** `fetchSource` / `fetchCreators` out of `SocialAgentRunService` into a service both roads
  call, and **switch `runPlan()` onto it in this same issue**. Two copies of paging is the exact
  failure this project exists to prevent.
- **Callback routes** `/api/worker/{tool,ai,step,output,notify,ask,finish}` per §C. `POST /tool` takes
  `{sourceId, pages}` and does the **whole paged, de-duped fetch server-side** — a worker has no
  database, so it cannot make paging decisions that depend on know-how cards.
- **Auth**: routes marked `@Public()` behind a dedicated `WorkerTokenGuard`; per-**spawn** tokens bound
  to `{runId, agentId, expiresAt}`, revoked when the worker exits (including into a pause). An owner
  browser session must NOT reach these routes.
- **`RunJournal`** (§H) with stable `stepKey`s; every effectful kit call records its result and returns
  the recorded value on replay.
- **`AgentRun.runKind`** (`engine|worker|plan`) — and teach `HermesBridgeService.resumeTick()`
  (`:191-204`) to skip non-engine runs. Without this a parked worker either strands for ever or wakes
  up as a live Codex turn.
- **Determinism**: the runner freezes `Date.now`, `Math.random`, `crypto.randomUUID` and points them at
  journalled `kit.now()` / `kit.random()`.
- **Automatic checkpoints** inside the kit's fetch/shape loops (every page, every creator, every batch).

**Acceptance**
- Parity: for a fixed set of `ToolSample`s, kit fetch+merge+shape MUST produce the same rows as
  `runPlan()` on the same plan.
- Replay: re-running a worker after a pause MUST perform zero repeat fetches, zero repeat sheet writes,
  zero repeat messages.
- A worker whose call order changes between replays MUST fail loudly ("not repeatable"), never do a
  step twice.
- An owner session cookie MUST NOT reach `/api/worker/*`.

## 3 — Per-job run lock  *(§G)*

Nothing stops the same agent running twice at once today: `AgentScheduler.tick()`
(`hermes/agent-scheduler.service.ts:54-78`) dedups only on `lastFiredKey`, and runs are
fire-and-forget promises.

**Build** a lock row (unique on `jobId`, holder, takenAt, expiresAt), claimed by compare-and-set,
released on terminal state, expiring on timeout so a crash cannot wedge a job. The scheduler, the
worker road and the repair loop all claim it.

**Acceptance** — two simultaneous starts of one job MUST result in exactly one run; a crashed holder
MUST free the lock within the timeout; an existing scheduled agent MUST still fire normally.

## 4 — The worker runner (host service)  *(§F)*

**Build** `services/host/worker-runner.server.js` + systemd unit, HTTP on the Docker gateway (confirm a
free port with `ss -ltnp`; 8766 proposed). `POST /run` spawns `node <folder>/current/worker.mjs`
detached with the token in the environment, timeout, `--max-old-space-size=512`, no shell, cwd pinned;
streams ndjson steps; `POST /build`; `GET /status`. It never opens the database. Refuses a worker whose
`meta.kit` major exceeds the app's kit version (the app can be rolled back; worker folders are not).
Install + rollback documented in `services/host/README.md`, versioned copy in the repo.

**Acceptance** — a hung worker MUST be killed at the timeout and the run failed honestly; steps MUST
appear on the run screen as they happen; a kit-too-new worker MUST refuse to start and say so.

## 5 — The build turn  *(§C, §D)*

**Build** plan → build brief (plan + kit docs + fact cards + samples) → **one fresh Codex session**,
`-s workspace-write`, `-C` the version folder. Codex writes `worker.mjs` + `worker.test.mjs`, runs the
tests against samples, and only green tests promote (`current` symlink move). `meta.json` with
`planHash`; a plan edit marks the worker **stale** and offers Rebuild — a stale worker keeps running
until rebuilt, never silently ignored.

**Acceptance** — a worker built from the Instagram plan passes its own tests; a build that cannot pass
leaves the agent on its previous road and says so; editing the plan marks the worker stale.

## 6 — Contracts  *(§E)*

**Build** `contract.json` written by Codex, `kit.expect()` before the output step, `ContractError` with
a readable reason, `allowEmptyWhen` preserving today's `nothingFound()` behaviour, and the contract
rendered in plain words in the UI.

**Acceptance** — recognising 0 rows from a non-empty answer MUST fail the run with a readable reason
(the BEA-1377 case); a genuinely empty vendor answer MUST still finish `done` with 0 rows.

## 7 — Ask and wait  *(§H)*

**Build** `kit.ask` / `kit.trouble` / `kit.checkpoint`; the question out through `sendOwnerAlert()`
(template-first, Meta verdict, Telegram fallback); **free-text answers with numbered choices in v1** —
there is no `send_buttons` tool and `send_list` is free-form (24-hour window), so tappable buttons are
a later piece needing their own approved quick-reply template. An `OWNER_WHATSAPP_NUMBER` check goes
**ahead of** the Contact lookup in `postbox-callback.controller.ts` (today an owner message matches no
Contact and is silently dropped). Deadline **12 h** + `ifNoAnswer`. Stall watchdog for **both** roads:
`running` with no step or checkpoint for `STALL_MINUTES` (20) → failed, owner told, lock released.

**Acceptance** — a two-day wait resumes correctly and repeats nothing; an owner reply with no open
waitpoint changes nothing; a **contact** reply still reaches Contacts and Reminders untouched; a
stalled run is failed and reported within `STALL_MINUTES`; a gated call parks and notifies on WhatsApp.

## 8 — Self-heal  *(§G)*

**Build** capture the failing answer as `ToolSample(kind:"failing")`; repair turn (fresh Codex session
with error + failing sample + contract + kit docs); **two** attempts, per failure cause, serialised on
the job lock, always against saved samples — **never a vendor call**; promotion guard: a repair that
moves rows on the parity suite beyond tolerance is offered to the owner instead of promoted; STOP sets
`pausedReason` **and** `enabled:false` (the existing convention) and tells the owner plainly; retirement
to the plan runner is the **owner's tap**, never silent.

**Acceptance** — a corrupted saved answer is caught, repaired, tested and promoted with zero vendor
calls; a repair that changes results is held for the owner; after two failures the agent is genuinely
paused and the owner is told what was tried.

## 9 — Housekeeping + the Worker tab  *(§I, §J)*

**Build** cleanup on agent delete (worker folder via the runner, lock row, journal rows, open
waitpoints — hand-kept, as `SocialWatch` already is); per-run cost (credits + AI tokens) shown on the
run screen and the Worker tab; the Worker row in the agent Settings accordion: version, built-at, test
status, the contract in plain words, staleness, repair history, **Rebuild**, and "run it the old way".

**Acceptance** — deleting an agent leaves nothing behind (asserted); the Worker tab reads correctly at
1180 and 390, light and dark; a paused-for-a-question run reads clearly on the run screen.

## 10 — Acceptance on a real agent

Rebuild **"Smart Home Instagram Profiles"** as a worker: same or better rows at the same credits as the
plan run. Then corrupt a saved answer to imitate a vendor change and watch it fail loudly, repair, pass
its tests and promote — **without a single vendor call**. Then a live ask-and-wait: the worker asks on
WhatsApp, the owner answers hours later, the run finishes from where it stopped.
