# Project rules — Claude MUST follow these

You build software here under a fixed, enforced flow. Full detail is in `RULEBOOK.md`; this file is the binding short version. The machine also enforces the key steps automatically (`.claude/checks/`) — they are NOT optional.

## The loop — one Linear issue at a time, in this EXACT order
1. **PULL** the next issue from Linear → set *In Progress* → re-read it.
2. **CLARITY CHECK** — if the issue is vague, **PARK it** (note why) and move to the next. Never build on a guess.
3. **BRANCH** for this one issue.
4. **CODE** only what the issue asks. No scope drift.
5. **TEST** — it works AND automated tests pass.
6. **REVIEW** — run the `code-reviewer` agent on this issue's diff. Fix every **critical/high** finding before shipping (3 attempts, then PARK). Low/medium: fix if quick, else note it in the sign-off. Never ship past a critical finding.
7. **SHIP** — run `.claude/checks/ship.sh <ISSUE-ID> "<ISSUE-ID>: <what you did>"`. One command does the whole finish: tests → standards → **commit** → deploy → confirm live → **merge into the default branch** → **push to GitHub** → log it → delete the work branch → assert nothing is left uncommitted or unpushed. All-or-nothing. You may NOT mark an issue done until it exits 0.
8. **CLOSE** the Linear issue + post a sign-off comment: *"what I did / what I didn't do"* — include the commit sha that ship.sh printed.
9. **NEXT** issue automatically. NEVER ask "what's next."

## Hard rules
- One **flat** Linear issue per task. NEVER create sub-tickets.
- **"Done" = committed AND pushed AND deployed live AND confirmed.** Coded-but-not-deployed is NOT done. Live-but-not-committed is NOT done either — that work is one `docker build` away from vanishing.
- **Never `git commit` by hand during the loop, and never close an issue without ship.sh.** ship.sh is the only path to done; doing it by hand is how steps get skipped.
- Don't beg per issue — work the approved batch straight through.
- Pause only for a **BIG** decision (costs money / irreversible / unclear). Small decisions: you decide.
- Plain English to the user. Never ask the user a technical question.

## When stuck (overnight)
- **Code bug** → try up to 3 times, then PARK it and continue with the rest.
- **Decision / risky / costs money** → PARK immediately for the user's OK.
- **Several issues fail in a row, OR the deploy breaks** → STOP the whole run (something is broken at the base).

## Standards — checked before ship
**Always, on every issue that touches the UI or data:**
- **Lists/tables:** pagination · search box on top · filters · sortable columns · total count · loading state · friendly empty state · clean formatting.
- **Forms/actions:** confirm before delete · success message · friendly errors (never a raw crash) · input validation · consistent file/photo uploads.
- **Look & feel:** responsive (check phone **and** laptop widths) · consistent design · accessible · dark mode · fast · consistent date/number formatting.
- **Secrets & connection:** secrets never in code or git · always HTTPS.

**When the project actually has them** (skip if it doesn't — don't invent scope):
- **Accounts & roles:** signup/login/logout · roles · encrypted passwords + safe reset · auto-logout on inactivity.
- **Notifications · profile & settings page.**

**CRUD for any "thing"** = list + create + read + update + delete, with the Always items above, role-aware, PLUS bulk actions, export, import, item history.

## Under the hood
Organized & documented · reuse don't repeat · built to grow · deploy straight to live (no staging — no users yet).

## Why these never get skipped
The machine backs these rules: tests block on red, files auto-format, dangerous commands are blocked, and `ship.sh` is the only path to "done" — it will not let you finish with work uncommitted or unpushed. Don't rely on memory — run the checks.

---
<!-- PROJECT-CONTEXT:START — generated. Refresh this section whenever the project gains a service,
     a dependency, a route group, or a new deploy step. Do not hand-edit the sections above it. -->
## This project

**My Brain** — the owner's private second brain, live at **https://mybrain.1site.ai** (single user, cookie session, no public signup).

**Layout**
- `api/` — NestJS + Prisma on **SQLite** (`/app/data/mybrain.db` in the container). One module per feature under `api/src/<feature>/`; register new ones in `api/src/app.module.ts`.
- `web/` — React + Vite + Tailwind PWA. Pages in `web/src/pages/`, shared components in `web/src/ui/`, routes in `web/src/App.tsx`.
- `.claude/checks/` — the enforced flow. `preflight.sh` (read-only), `ship.sh` (the ONLY path to done), `deploy.sh`, `healthcheck.sh`.

**Running the checks**
- Tests: `( cd api && npm test )` then `( cd web && npm test )` — the value in `.claude/checks/test-command`.
- Types: `npx tsc --noEmit` in each of `api/` and `web/`. Do this before shipping; it catches more than the tests.

**AI Radar (BEA-1311→1313)**
The Radar tab on `/news?view=radar` mirrors an external collector — the fork `inai-sandy/ai-news-radar`, which fetches/dedupes/scores AI news hourly on GitHub Actions and publishes JSON to GitHub Pages (`RADAR_BASE_URL`, default `https://inai-sandy.github.io/ai-news-radar/data`). `RadarFeedService` syncs it hourly into `RadarItem` with counted results and translates any Chinese title at sync (free Google endpoint, `radar-translate` helper fallback) — an item is NEVER listed untranslated (`pendingTranslation` hides it). `RadarWriteService` writes the picks' one-line notes in batched `radar-why` engine calls — an hourly check that only calls the engine when a pick lacks its line (honest-runs: failures leave picks pending). The upstream feed list lives in the fork's `FOLLOW_OPML_B64` repo secret, not in this repo.

**Outside services (BEA-1345 · BEA-1346)**
The owner manages them at **`/tools`** (next to Skills) — browse all 1,209, connect, several
accounts per service, rename, disconnect. It talks only to `/api/tools/services*`
(`tools/services.controller.ts`), which talks only to the seam. Three connect roads, all decided by
the toolkit and never guessed: **121** services have a one-click login, **1,056** need the owner's
own app or key (the common case — it gets a real form, with the fields split into the two halves the
vendor reads), and **32** need no sign-in at all and must NOT be offered a Connect button, because
Composio answers HTTP 400 for those. Shapes in `specs/COMPOSIO-API.md`.

**Running one is direct, and written down (BEA-1347).** A flow step whose id starts with `svc:`
goes through `ServiceActionsService` (`api/src/tools/service-actions.service.ts`) — never an engine
turn, because deciding what to do next earns one (~118,000 tokens) and calling an API does not. The
action is already named by the splitter, its schema is fetched exactly (`GET /tools/<SLUG>`; the
list endpoint's `search` is not semantic and would run the wrong action), and the only model call is
the small capped `service-args` helper that fills the arguments. **Every road but a real success
throws** — an `svc:` id is not in `AGENT_TOOLS`, so a returned string would fall through to
`askModel()` and invent a result. Every attempt writes a `ToolCall` row (arguments with secrets
masked, result, ok, ms), including the ones that never left the building; that table is also the
trigger echo guard's source of truth. Two connected accounts and no choice = a failed step naming
both **labels**, never the raw ids.

**Only what cannot be undone stops and asks (BEA-1348).** Full access with gates: normal writes —
create an issue, comment, send a message, change a field — run with no friction, and the owner should
see a gate about once a week, so an implementation that gates too much has FAILED even with green
tests. `isRiskyAction()` in `service-provider.ts` is the only place that decides (a read is never
gated; hand-kept must-gate and allow lists sit either side of the spec's rules). The gate fires in
`ServiceActionsService.run()` after the arguments are filled and before `execute()`, writes its
`ToolCall` row first and then **throws** `GatePause`; `flows-runner` turns that into the durable
"waiting" pause (BEA-795), and a yes re-runs the step with the exact arguments the owner approved.
Release one for good in `/tools` (per service, never per agent) — a `ServiceGate` row.

**Chat can act, and it confirms inline (BEA-1349).** `api/src/chat/chat-tools.service.ts` joins the
same runner and gate to Chat: two small picks (service names first, then that one service's actions —
never an id outside the owner's own catalog), then `ServiceActionsService.run()` with
`runKind: 'chat'`, `runId` = the session and `nodeId` = the **user message id**. A `GatePause` becomes
a card in the thread with Run / Cancel — no durable waitpoint, no notification — and Run re-runs with
the *approved* arguments (never re-filled). **When nothing is connected, Chat must behave exactly as
it did before: `ChatToolsService.available()` returns early with no prompt built and no model call,
and `chat-tools.spec.ts` locks that down.** A gate and a failure both skip the answer call, so a
refusal reaches the owner in the service's own words instead of as a polite apology.

**And the other direction: a service event starts a flow (BEA-1350).** `api/src/triggers/` — its own
module, because `FlowsModule` already imports `ToolCatalogModule` and a triggers service inside the
catalog would be a cycle. Events land on the ONE public route `POST /api/tools/triggers/events/<secret>`
(`@Public()`, the secret is the last path segment, compared with `timingSafeEqual`), which answers
**202 before doing the work** — a provider kept waiting retries, and a retry is a duplicate run. The
address is masked wherever it is shown, because the secret IS the last segment. Ids are `evt:<service>.<event>`,
the mirror of `svc:` and for the same reason. Counts are per service and can be **zero** (Sentry,
Vercel), which the UI says in a sentence rather than drawing an empty picker, and each event says
whether it is instant or polled (and how often) from the provider's own answer.
**The two guards are the point:** the echo guard (`triggers/echo-guard.ts`) drops events we caused —
a read is never blamed, then identity, then subject — and it must **never filter on `runKind`**,
because Chat writes to the same `ToolCall` log and a chat-sent message echoes exactly like an
agent's; and the rate cap (20 runs/hour) makes a runaway binding pause itself, drop its subscription,
record why and push a Telegram message. **Switching a binding off, pausing it or deleting it removes
the trigger instance at the provider** — an orphan keeps billing events for a rule the owner thinks
is gone. A trigger-started run has nobody watching it, so it uses the durable pause, never Chat's
inline card, and `FlowRunnerService.start(flowId, { input })` carries the payload in on the run row.

**Google is an outside service too, since BEA-1351.** The gws CLI bridge on the host (`google.service.ts`,
`GWS_RUNNER_URL`, `/gws`, `/gws-file`) is GONE; the four daily Gmail/Drive features (Daily Brief,
Requests, email memory, Drive→Gmail import) and the whole `/google` page read through
`GoogleWorkspaceService` (`api/src/google/google-workspace.service.ts`) → `provider.execute()` with
`svc:gmail.* / svc:googledrive.* / svc:googlecalendar.*` ids on the accounts connected at `/tools`, and
every read is a `ToolCall` row (`runKind: 'google'`). Google's own message payload arrives identically on
this road (proven side by side on the same inbox before the switch — commit a6abf7b holds the comparison
script), so the parsing lives once in `gmail-parse.ts`. Traps: a Gmail list comes back in ARRIVAL order
(re-sorted by `messageTimestamp`); binary content is a short-lived staged URL, fetched and capped in
`bytesFrom()`; `GOOGLECALENDAR_EVENTS_LIST` has a stale default `timeMax` — always pass it;
`GOOGLEDRIVE_GET_FILE_METADATA` returns only id/name/mimeType, so the link and size come from a
by-name search. Docs/Sheets/Slides/Tasks/Meet/Chat are their own toolkits (`googledocs`…) and say
"connect it in /tools" until they are. The catalog has NO Google group of its own any more — the bare
`gmail`/`calendar`/`drive` ids stay in `AGENT_TOOLS` only so flows saved before this keep dispatching.

Anything the app does not own reaches the catalog through the `ServiceProvider` seam in
`api/src/tools/service-provider.ts`, implemented today by `ComposioProvider` over Composio's v3 REST
API (`specs/TOOLS.md` for the design, `specs/COMPOSIO-API.md` for shapes that were verified live).
Ids are `svc:<service>.<action>` and **the vendor's name may never appear in one** — they are
dispatched on and stored inside saved flows, so a vendor name would make the provider unswappable.
Counts (`871 GitHub tools`…) are always read from the API at run time; Composio's own docs and
marketing pages disagree with it and with each other. The key is the `composio` connector (encrypted,
Settings → Connections) and `COMPOSIO_API_KEY` in `deploy.sh`; `exa · firecrawl · tavily · perplexity
· telegram · whatsapp` are blocked because we already do them better or they are ours.

**Social platforms come through the same seam, from a second provider (BEA-1355).**
`ScrapeCreatorsProvider` (`api/src/tools/scrapecreators.provider.ts`) sits beside `ComposioProvider`
in `ToolCatalogService` (group **Social**) and in `ServiceActionsService`, which now picks the provider
**per action id** (`social.owns(id)`, exact — both providers can know a service called `github`).
Every action is GENERATED from their OpenAPI spec (`https://docs.scrapecreators.com/openapi.json`,
178 ops / 29 platforms on 2026-08-17): read at boot, daily and on `refresh()`, last good copy kept
on disk under `DATA_DIR`; **a test asserts action count == the spec's op count, no cap**. Ids are
`svc:<platform>.<endpoint>` from the path (rule in `specs/SCRAPECREATORS-API.md`); nothing here is
ever gated (all reads); one key per instance = the `scrapecreators` connector (`SCRAPECREATORS_API_KEY`
in `deploy.sh`). `execute()` returns `credits` read off the answer's `credits_charged` (0 on a cache
hit) and `ToolCall.credits` records it — never assume 1, costs run 1→26. The Social UI, Watch/Alert
and the owner's example agent are BEA-1356→1359. Trap: their Google-indexed searches (hashtag,
reels) can answer `404 {error:"not_found"}` "No posts found" for everything for a while — recorded as a
failed `ToolCall`, 0 credits, and `ExecuteResult.notFound` rides through `runDetailed()` (BEA-1359).

**Every action of every connected service is in the catalog — no shortlist, no cap (BEA-1354).**
The owner's rule: "do not skip any action from providers." `ComposioProvider.listActions()` walks the
whole cursor-paged list (`limit=1000` is honoured — GitHub's 823 in one ~1.4s page; the toolkit's
`meta.tools_count` says 871 and the list is what counts; 42 are `is_deprecated` and since BEA-1365 they STAY,
as `ServiceAction.retired: true` — pickers show a muted "retired" tag after the live ones, `tool-shortlist.ts`
ranks them last, the `/tools` sheet says "823 actions (42 retired)"; nothing filters on it), cached 5
min; the vendor's "important" mark rides on each action from its `tags` as a HINT only. The catalog
serves its last good copy at once and re-reads BEHIND the answer when old (`serviceTools()`,
generation-aware so a connect/disconnect is seen at once, warmed at boot); the 8s budget + last-good
fallback stay. **A prompt is never shown the whole list**: Chat's second pick, the flow planner, the
job builder and EMO's tool pick all go through `tool-shortlist.ts` (keyword rank → important → order,
40 per service by default) — a picked toolbox is always offered in full. Pickers (`ToolPicker`, the
Flows palette) fold Services/Social per service — closed with a count, search-within-service, 40 a page
(`web/src/ui/ServiceFolds.tsx`). Gates (`listForService`) are computed over the full set; the `/tools`
sheet shows `availableActionCount` for a connected service. Trap: `MAX_ACTIONS` in `chat-tools` is a
prompt cap, not a catalog cap — putting `important`/`limit` back on any `listActions()` call reopens this.

**The Social section is where that data gets USED (BEA-1356).** Sidebar entry **Social** under Automation
→ `/social` (platform grid: every platform from `provider.listServices()` MINUS the vendor's own `account`
platform — `VENDOR_PLATFORMS` in `social.service.ts`, a display choice only, `svc:account.*` stays in the seam
(BEA-1365) — mark by slug with an initial-tile
fallback, endpoint count, header with credit balance · today's spend · daily ceiling) and `/social/:platform`
(EVERY endpoint from `provider.listActions()`, grouped by the spec's own tags, a form generated from each
action's JSON schema, and **Run** right there). It talks only to `/api/social*` (`api/src/social/`):
`GET /api/social` · `GET /api/social/spend` · `GET /api/social/platforms/:slug` · `POST /api/social/run
{actionId, args}`. The run goes through **`ServiceActionsService.runDetailed()`** — the same one code path
`run()` wraps (`run()` = `runDetailed()` + throw), so there is still exactly ONE `execute()` call site and
the `ToolCall` row (`runKind: 'social'`, `credits`) is written like an agent's; `argsPinned: true` means the
form IS the arguments and the model is never asked. Answers are drawn by shape (`web/src/pages/social/
resultShape.ts`: transcript → text, list → `DataTable`, profile → card, else JSON) with `credits_charged`
beside them ("cached · 0"); a vendor 402 comes back as `outOfCredits` + a top-up link, never a raw error;
"load more" follows `cursor`/`page` and stops at their 11-page cap. Result actions: Save as Document
(`POST /api/documents`), Send to Capture (`POST /api/items/upload`), Make it an agent (navigates to
`/agent?builder=1&tool=<id>&args=<json>` — the builder-side handoff is BEA-1357). Today's spend = sum of
`ToolCall.credits` since the owner's local midnight over social platforms; the ceiling Setting
`social.dailyCreditCeiling` is only READ here ("no limit set" until BEA-1358 adds it).

**A Social agent is an ordinary Agent, and it never starts an engine turn (BEA-1357).** "Make it an
agent" on a Social result opens the normal builder form (`NewAgentForm` in `Agents.tsx`, via
`/agent?builder=1&tool=<svc id>&args=<json>&label=…` — `readSocialPrefill()`) pre-filled: name in the
owner's words, the tool + its EXACT arguments (editable, `ToolArgsEditor`), task = `KEEP_AS_FETCHED`,
output destination (Google Sheet by default), WhatsApp toggle, schedule. Saving is a plain
`POST /api/agent/agents` with `origin:'social'`, `category:'Social'`, `tools:['svc:…']` and the new
`Agent.toolArgs` (JSON `{[svc id]: args}`). At run time `HermesBridgeService.execute()` forks BEFORE the
toolbox/prompt/Codex to `SocialAgentRunService.run()` (`api/src/social/social-agent-run.service.ts`)
whenever every tool is a `svc:` id with pinned args (`handles()`): each fetch is
`ServiceActionsService.runDetailed()` with `runKind:'agent'`, `argsPinned:true` (ToolCall rows with
`credits`, no `service-args` call), rows come from `rows.ts` (`tableOf`: list → rows, profile → ONE row,
nested one level flattened), and the ONLY model call is the `social-shape` helper (Sonnet 5, Settings
"Social rows model") — and only when the task says more than "as fetched" (named columns · a filter like
"in India" — recall over precision). **`outputDest:'sheet'`** is a first-class destination beside
document (`OutputDestPicker`, on the builder and the job's Settings): create `svc:googlesheets.
create_google_sheet1` → write `svc:googlesheets.batch_update` at `A1` (header + rows), or with
`Agent.sheetId` set: `batch_get` `Sheet1!A:A` + `Sheet1!1:1` first (count + header, and the header is
handed to the shaping step) → append from `A<n+1>` under the sheet's OWN columns (`remap`). Create
returns NO url — `sheetUrl(id)` builds it; it lands on `AgentRun.outputUrl` (run screen "Open the
sheet", History "sheet ↗"). Sheets not connected → the run FAILS with "Connect Google Sheets first —
open /tools…" (the run screen adds an Open Tools button), never a silent skip; a shaping model that
answers nothing fails the run too. The ENGINE road honours it as well: `driveTurn()` calls
`SocialAgentRunService.deliverTextToSheet()` for an ordinary job set to `sheet` (answer → rows via
`social-shape` → the same writer), and any failure fails the run — never a quiet fallback to Documents. `notifyWhatsApp` sends the sheet link through
`AlertsService.runFinished()`; a "no number" answer is SAID on the run as a step ("no WhatsApp number in
Settings"), on both the direct and the engine road. `telegram`/`task` destinations are still only names
in the schema — nothing dispatches on them yet. Traps: `ORIGIN[j.origin]` in `AgentAreaPage` crashes on
an unknown origin (now `originOf()`); a pasted sheet URL is cleaned to its id on both sides
(`cleanSheetId` / `sheetIdFrom`); never find-and-delete a Drive file by name (`specs/SCRAPECREATORS-API.md`).

**The owner's example is a two-source digest, and an empty search is not a failure (BEA-1359).**
"Instagram posts about smart home in India, last 30 days → a Google Sheet → my WhatsApp, every
Monday 08:00" is ONE Social agent with TWO sources (`Agent.tools` = `svc:instagram.search_hashtag` +
`svc:instagram.reels_search`, each with pinned `toolArgs`), built through the Social UI: the builder
form and the job's Settings both have **Add another source** (`AddSourcePanel` — the platform page's
schema form, moved to `socialShared.tsx`, one drawing) and Remove; sources are fetched one after the
other and `mergeTables()` unions them under a `source` column; the shaping task de-dupes and filters.
The `SchedulePicker`'s weekly choice names its day (`dow`, "Every Monday at 08:00"; the scheduler
fires in `tasks.tz`, default IST). Inside `SocialAgentRunService.run()` a fetch that comes back
`notFound` on a SEARCH endpoint (`isEmptySearch()`: the vendor's `not_found` AND the endpoint has
"search" in its name) is an EMPTY SOURCE — a done step "… — no posts found (vendor answered not_found)
· 0 credits", not a failed run — so a digest whose second search has nothing still writes the sheet;
a not_found on a profile/post lookup, a transport error, 401/402/429/5xx or any other `success:false`
still FAILS the run. Every source empty → the run finishes done and honest ("0 posts found — nothing to
write, no sheet made"), no sheet, no WhatsApp. The sheet is titled `<job name> — <YYYY-MM-DD>` per run.
The Social page draws the same `notFound` as a calm "Nothing found for that — right now" (0 credits)
instead of a red error, and STILL offers "Make it an agent" — a schedule is how you keep asking.
The shaping model is shown `shapeInput()` items — signed CDN links (`isVolatileUrl`) and blanks
dropped, cells capped at 700 chars (half of a 12-post answer was expiring picture URLs) — and its
call asks for `{ timeoutMs: 180_000 }` through the new `LlmCallOpts` on `completeHelper/complete/
completeWith/completeWithModel` (default 60s, ceiling 5 min): the first live shaping batch on Sonnet
was cut off at the one-turn 60s and the run failed "the shaping model returned nothing".

**Watch and Alert remember last time (BEA-1358).** `Agent.mode` = `run` (fetch every time) | `watch` |
`alert`, chosen on the Social builder form and the job's Settings (`WatchModePicker` in
`agentJobFields.tsx`, one drawing for both). Inside `SocialAgentRunService.run()` the fetch is the same;
then `watch()` diffs each tool's answer against its `SocialWatch` row (one per agent × action × args
hash — `social-watch.store.ts`) with the pure `social/diff.ts`: **lists** → new items by a stable id
(`KEY_FIELDS`: id, pk, shortcode, url, aweme_id…, NEVER position; an item that drops off the page is not
a change), **numbers** → previous → current for every number that moved (+ a `Threshold {field?, dir,
value}` judged here, no model), **text** → changed/unchanged with a "what changed" line. The envelope
(`credits_charged`…) and signed CDN links (`?oh=…&oe=…` on every profile picture) are stripped before
hashing, or nothing would ever be "unchanged". First run = baseline ("watching from now", nothing is
new); nothing changed = the run says so, writes NO document, sends nothing, refreshes `lastAt`; changed →
only the diff goes to the output (document, or `diffTable()` rows to the sheet). An Alert judges a
numeric threshold once per crossing (`crossed` = met now AND not met in the stored last — a number
that stays above pushes once) and/or a plain-English condition with ONE `completeHelper('social-alert')`
call over the diff (a null answer FAILS the run); when true → Telegram (`TelegramService.notifySocialAlert`)
+ WhatsApp (`AlertsService.runFinished`); reaching nobody fails the run. **The store is written only after
every step succeeded** — a failed fetch, write, judge or push never overwrites the last good result.
**Daily credit ceiling:** `Setting social.dailyCreditCeiling` (default 500, 0 = no limit; Settings →
Agents & Engines → Social credits, `socialDailyCreditCeiling` on `/api/agent/settings`; the Social
header reads it) is checked by `SocialBudgetService.check()` BEFORE every Social call in a job (spend =
the same `ToolCall.credits` sum the header shows; next-call cost = last cost of that action, else 1);
over → the job pauses itself (`enabled:false`, `Agent.pausedReason`, `notifyJobPaused` on Telegram, run
failed with the reason) and the call is NOT made; switching a job back on clears `pausedReason`
(`AgentApp` banner + "Switch back on"). `SocialModule` imports `TelegramModule` (Telegram → Daily →
Mentor → Push, never back — `PushModule` cannot import Telegram, which is why the alert's Telegram leg
is not inside `AlertsService`). Traps: `SocialWatch` has no FK — `deleteAgent` deletes its rows by
hand; `GET/DELETE /api/social/watch/:agentId` ("watching since", "Forget what it saw").

**Every agent shows its flow picture, automatically (BEA-1366).** The Flow tab (`AgentApp` → `FlowPanel`
in `AgentJobPanels.tsx`) opens ON the picture, run screen on top; the "Draw the flow" button remains only
for a legacy job with no flow at all. Two roads, one seam: `AgentFlowSyncService` (`api/src/flows/
agent-flow-sync.service.ts`) registers itself with `AgentService.setFlowSync()` at boot (AgentModule cannot
import FlowsModule) and runs after every `createAgent`/`updateAgent` (`createAgent(input, { drawFlow:false })`
opts out — the voice research job draws its own). **A Social agent (direct runner) is BUILT, never planned**:
`buildSocialFlow()` in `api/src/social/social-flow.ts` is a pure function of the same facts `SocialAgentRunService.
run()` reads — one `tool` node per source (`src:<svc id>`, args + last-known credits from `ToolCall`), `merge`
(mode raw, an honest "Union" — `mergeTables()` never de-dupes; only the shaping step does what the task says) when >1, the `ask_ai` shaping node ONLY when `wantsShaping()` AND mode is
`run` (a Watch never shapes), `filter`/`if` for watch/alert, the writer (`svc:googlesheets.create_google_sheet1`
| `batch_update` for append | `save_document`), `whatsapp`/`telegram`, then `output`. Existing kinds only, and
every node carries `say` (its plain-English line, which `describeFlow`/`stepAction` prefer). Saved
`locked:true` + `drawnBy:'social'` through `FlowsService.saveDrawn()` — the one writer past the lock — and
the canvas is READ-ONLY for it (`FlowEditor readOnly`, also auto on `/flows/:id`), because the runner never
executes this graph and an edit would fork from what runs; a save that touches `SOCIAL_KEYS` (tools,
toolArgs, outputDest, sheetId, notifyWhatsApp, mode, prompt, alertCondition, threshold, name) rebuilds it in
place, a pause does not; `backfillSocial()` draws every Social agent 15s after boot, idempotent (an equal
graph is not rewritten). **Every other agent is planned on save** — create and any prompt change — via
`planAndSave` in the BACKGROUND (`Flow.drawStatus:'drawing'`, the panel polls every 3s; one planner per flow,
a mid-plan save queues exactly one more); legacy normal agents are NOT planned at boot (a model call each); flows left `'drawing'` by a
deploy are swept to `'failed'` at boot (`reconcileStuckDrawing`), same rule as the AgentRun reconciler.
**A planner failure keeps the last picture**: `planAndSave` no longer overwrites a real graph with the bare
Ask-AI stand-in — it sets `drawStatus:'failed'` + `drawNote` (`REDRAW_FAILED_NOTE`) and the panel says so with
Try again; a first draw that fails still saves the marked fallback (never blank). The Chat path no longer
calls `/plan` itself (that made two plans) — `patch()` reloads the flow and the server does it. Draw/re-draw
from the UI = `POST /api/flows/agents/:agentId/draw` (server decides which road). **Runs mark the picture**:
a Social run's steps carry `nodeId` (the ids above); `nodeResultsFromRun()` folds the newest job run's
`stepLog` into `FlowEditor runResults` → the existing `RunBadge` ring + a small note per node (`info` steps
read as skipped). Traps: `Flow.drawnBy/drawStatus/drawNote` are new columns (migration `flow_drawn`);
`jobBuilderCreate` now passes tools + notifyWhatsApp INTO `createAgent` so the first plan sees the toolbox;
`FlowsService.update()`'s locked guard is untouched, so a hand edit of a social flow answers 400 by design.

**Every action has a fact card — the know-how the thinking builder (BEA-1371) will read instead of one-line names; today a person opens it (BEA-1368).** `ToolKnowledgeService`
(`api/src/tools/tool-knowledge.service.ts`) builds ONE `ToolKnowledge` card per `svc:` id from three parts, each said
with its source: **spec** (ScrapeCreators from the parsed OpenAPI already in the provider — params, the 200 example's
fields, cost prose; Composio from its exact `GET /tools/<SLUG>` through `provider.getAction()` — `input_parameters` +
`output_parameters`, now carried as `ServiceAction.responseSchema` on the exact fetch ONLY, never on the list, or the
catalog gets heavier), **observed** (`ToolCall` rows, last 30 days: fields seen in recorded answers — a capped walk, a
recorder-truncated answer only teaches flat keys, secret-named keys never carry an example, signed links lose their
query — items per page when a whole page was recorded, real `credits` typical/min/max, and **health** over 24 h: a
`not_found` on a search endpoint is "empty answers", said as such, and still `ok:false` when it is every call; held-for-
approval rows are neither a success nor a failure), and **notes** (`knowledge-notes.ts` — the hand-kept traps, keyed
by exact id / `svc:x.y*` glob / bare service, and a note may pin paging or cost where the spec is silent: popular
search 12/page; the spec wins where it speaks). Routes `GET /api/tools/knowledge/:actionId` (`?fresh=1`) and
`POST /api/tools/knowledge/lookup {ids[]}` (≤ 50, six provider fetches at a time), cached 10 min in memory, never on the
catalog's path. UI: `web/src/ui/ToolFacts.tsx` — the small "Facts" fold on the Social endpoint card and on the `/tools`
sheet's action rows (the gate rows are the only per-action rows that sheet has); it fetches only when opened. Trap: the
recorder keeps 2000 chars of pretty JSON, so an observed page size exists only for short answers — the note fills it.

**A Social agent runs a PLAN, and the plan has blocks (BEA-1369, `specs/THINKING-BUILDER.md` §C).** `api/src/social/plan.ts`:
`planFromAgent(agent)` (pure) → `AgentPlan { sources:[source|creators], merge, shape?, watch?, output, notify, schedule, ceilingNote, prompt, mode }`;
`SocialAgentRunService.run()` is `runPlan(planFromAgent(agent))` and `buildSocialFlow()` is `buildPlanFlow(planFromAgent(agent))` — one plan,
the runner executes it and the picture draws it, so they cannot disagree (`KEEP_AS_FETCHED`/`isDirectFetchAgent`/`wantsShaping` now live in
`plan.ts`, re-exported from `social-flow.ts`). Two blocks are new, both stored INSIDE `Agent.toolArgs` as data (no schema change):
**pages** — `toolArgs[svc id]._pages` (1..11, default 1; `plainArgs()` strips `_`-keys before the vendor sees them): `fetchSource()` sends
page 1 as always, then the vendor's cursor (`nextCursorOf`: cursor · next_max_id · end_cursor…) or the next page number under the param the
know-how card's `paging.field` names (else inferred from the answer's cursor key, else a `page` already in the args, else "does not page"),
ONE `ToolCall` per page with its credits, items de-duped on `dedupeKey()` (`itemKey` id fields, never position), early stop on no cursor /
an empty (not_found) or repeated page, and `SocialBudgetService.check()` before EVERY page; a later page that fails for any other reason
FAILS the run (nothing written). One page = the raw answer as before (a profile stays a profile); several = `{[listKey]: items}`. Step:
"Fetched Instagram · Popular Search — 96 items over 8 pages · 8 credits · stopped early: page 9 was empty". A Watch keys its baseline on
the plain args, so more pages never forgets a baseline. **creators-first** — `toolArgs[<finder svc id>] = { kind:'creators', find:{actionId,
args, take≤50}, then:{actionId, argsFrom:{ handle:'username' }, args?, keepDays?} }`: `fetchCreators()` runs the finder once, takes the
first N distinct creators (`creatorField()` reads flat · dotted · one level down), runs the per-creator action once each (`argsFrom` maps a
creator field into the argument, `then.args` are fixed extras like `trim:true`), keeps items newer than `keepDays` when the items carry a
date (`dateFieldOf()`: the card's `fields[].kind==='date'` inside the list, e.g. `items[].taken_at` epoch seconds — verified live on
`svc:instagram.user_posts` — else the usual names; else EVERYTHING is kept and the step says so), merges under a `creator` column
(`{items:[{creator,…}]}`), de-duped by id; ceiling before every call; a failing creator is said + skipped (≥1 success, else the source
is empty-with-reason, like a not_found search); no `then.actionId` → the run fails plainly. Step: "5 creators · fetched posts for 5 · 24 kept
from the last 30 days (of 60) · 6 credits". `estimatePlanCost(plan, cards)` → `{credits, aiTokens, items, how}` (pages × the card's
`cost.credits.typical` else 1; creators = finder + take × per-call; items = pages × `paging.pageSize` else 12; shaping ≈ items × 300 tokens,
0 on a Watch) — `GET /api/social/plan/:agentId` answers `{plan, cost}` and the job page header shows "≈ N credits per run" (`data-testid=
plan-cost`, the arithmetic as its title; the "What it fetches" note repeats it). UI: `PlainSourceEditor` (a "pages" field, shown while the
card is unknown or says it pages, hidden when `paging.how==='none'`, `pagesCostHint`), `CreatorsSourceEditor` (finder args · N · then-action
picker from `/api/social/platforms/:slug` · argument ← creator field · days) — `ToolArgsEditor` picks by `isCreatorsArgs(args)`; `AddSourcePanel`
has a **Creators first** switch (`creatorParamOf(schema)` guesses `handle`/`user_id`, `creatorFieldFor` → `username`/`id`). The flow node for a
paged source is "Instagram · Popular Search × 8 pages — … about 8 credits per run (8 pages × 1)"; a creators block is ONE node
"Find creators → their posts" (`refId` = the finder, `args` = the block); `AgentFlowSyncService` names/costs every id in `planActionIds()`.
**More pages = more items = a bigger shaping reply:** the first live 5-page run (60 items) came back CUT OFF at the shaping step's
12k-token ceiling and the run failed honestly — so `SHAPE_BATCH` is 30 items, `SHAPE_MAX_TOKENS` 32k, and a reply that is still cut
mid-row is salvaged to its complete rows (`salvageRowsJson`, exported + tested) instead of "not the JSON asked for".
A per-creator answer goes through `itemsOf()`: a list → its items; a LIST-SHAPED answer with nothing in it (`{items: null, user, more_available:
false}` — what a private/empty account answers, seen live) → 0 items, never one row of envelope; only a plain object with no list key (a
profile lookup as the per-creator action) is one row — and the date field is decided over EVERY creator's items together, or the first
empty account switched "last 30 days" off for everyone (found on the first live creators run).
Traps: `SocialAgentRunService`'s constructor gained `knowledge?: ToolKnowledgeService` LAST (positional harnesses); the finder id doubles as
the block's key, so one job holds one creators block per finder action; `_pages` on an action that does not page costs one call and the step
says "this endpoint does not page (5 pages asked)".

**The agent engine**
Agent runs execute on **Codex directly** via a host runner at `http://172.18.0.1:8765` (`/home/sandy/codex-runner/server.js`) — Hermes was removed in 2026-06. The runner only takes a prompt; it offers **no per-run tool gating**, which is why the toolbox is enforced on our side (`flows-runner` refuses a step, the prompt declares the allowed set). My Brain's own tools reach the model as a host **MCP server** (`~/.codex/config.toml [mcp_servers.mybrain]`), mounted statically for every run.

**NEVER mount a search tool on an engine turn** (BEA-1202). Exa's hosted MCP was registered here in BEA-1196 so engine turns "could search too" — which reopened the door BEA-1194 exists to close. A model with its own search decides *how* to search, spends outside our budget, and is invisible to `FlowRun.spend`. It has been removed; `codex mcp list` must show only `mybrain`. The same applies to any engine added later.

**Web search is NOT an engine turn.** `web_search` / `web_read` (Tavily), `web_search_meaning` (Exa) and `deep_research` are direct calls in `api/src/tools/` (`web-research.service.ts`, `deep-research.service.ts`), dispatched inside `runNode` — they are deliberately absent from `AGENT_TOOLS`. Putting them back would hand the choice of *how* to search to the model, which is the bug that made a research run cite 2021 figures for 2025. They never fall back to the model: a failure fails the step with its reason.

**Deep research is ours, and it is budgeted.** `deep_research` (BEA-1196) plans sub-questions, runs the searches itself, reads pages and writes the cited report on the **flat-rate** engine — the `deep-research` entry in `LlmService.HELPERS` defaults to Codex on purpose, because the point was that a report costs only search credits (~30c) instead of Perplexity's ~$1–2. Hard caps live in `deep-research.service.ts` (`HARD_CAP`: 24 searches, 10 page reads — raised from 8 in BEA-1239, when every question started sweeping all three indexes) and no node setting can exceed them. What a run actually spent is stored on `FlowRun.spend` and shown in the Runs list.

**Things that will bite a fresh session**
- **Flow tool ids are load-bearing.** `flows-runner.service.ts` dispatches on them (`AGENT_TOOLS`, `toolPrompt`). Renaming an id silently breaks every flow already saved in the database. Adding ids is safe, but an id not in `AGENT_TOOLS` falls through to a plain model call — fine for reasoning, wrong for a lookup, because it will invent the answer.
- **One tool catalog.** `api/src/tools/tool-catalog.service.ts` (`GET /api/tools/catalog`) is the single source for the agent toolbox, the builder chat and the Flows canvas. Do not start a second list.
- **Optional deps go LAST in a constructor** — many spec files build services positionally with fewer args. Guard optional delegates with `?.` too: spec harnesses pass partial Prisma stubs, so `this.prisma.flow.findMany` throws where `this.prisma.flow?.findMany?.()` degrades.
- **`llm.complete()` runs on the app's GENERAL model, not the engine.** Its `label` argument is only a usage-log tag — it selects nothing. That setting is a moving target (`qwen/qwen3.7-max` → `moonshotai/kimi-k3` inside one day), so a bare `complete()` is how agent work silently ended up on a model nobody chose. Use `completeHelper('<key>', …)` with a key registered in `LlmService.HELPERS`, and a test in `llm/agent-calls-follow-a-named-model.spec.ts` enforces this for the flow, agent and bridge services. A helper that HAS a model now returns null rather than quietly finishing on the general one (BEA-1248).
- **This project compiles with `strict: false`, so discriminated unions do NOT narrow.** `{ok:true;a}|{ok:false;b}` looks right and fails to compile — without `strictNullChecks` TypeScript will not narrow on the literal, so every `x.b` after `if (x.ok)` errors. Use optional fields (`{ok:boolean; a?; b?}`) instead; see `hermes/grade.ts`.
- **A job's last run can be an agent run OR a flow run.** Anything deep — and every voice job — runs as a flow. Query both or the UI will say "never ran".
- **Deploying kills in-flight runs.** `ship.sh` does `docker rm -f`, and the boot reconciler fails anything left `running`. Don't ship while a long run you care about is going.
- **QA the UI for real.** Playwright-core + cached Chromium at `~/.cache/ms-playwright/chromium-1228/`; log in via `POST /api/auth/login` with the creds in `.claude/checks/secrets.env` and set the `mb_session` cookie. Check **390 and 1180**, and assert `document.documentElement.scrollWidth === window.innerWidth` — a single wide table can push the whole page sideways.
- Prompts are editable at runtime (Settings → Prompts); defaults live in `api/src/prompts/prompts.service.ts`. Add a key to the union type AND the registry.

<!-- PROJECT-CONTEXT:END -->

