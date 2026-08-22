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

**Gmail is read at 21:00 and 23:30 local, and at no other time in the background (BEA-1399).** Composio
counts every call and the owner's quota is small. Before this, the Daily Brief's 60-second ticker called
`google.status()` every minute — a `GET_PROFILE` every 30 min that was kept OUT of the ToolCall log on
purpose (`quiet: true`) and a 5-min Composio metadata refresh — and a missing yesterday-brief made it retry
the whole read every minute. Now `GmailBriefService.briefTick()` checks the CLOCK first (`gmail-schedule.ts`:
`EARLY_AT`/`FINAL_AT`, the owner's numbers): 21:00 = the early pass (full read, Telegram, email memory; the
mails are kept in `gmailbrief.earlyMetas`), 23:30 = the final pass (`gmailImportantSince(day, earlyAt)` —
only what arrived after the early read; nothing new → unread refreshed, no push; new → re-summarise early +
new, push again, sync only the new); no early pass behind it → the full read. Each window is tried ONCE
(markers `gmailbrief.earlyDone/earlyAt/nightlyDone`, set even on failure) and a missed night is caught up
once the next day (`gmailbrief.catchupTried`). A failed list read FAILS the pass — it never writes "no
important emails" about a day it did not read. `status()` reads the remembered address (Setting
`google.email`, learned by ONE counted probe); there are no quiet calls any more — every Gmail call is a
ToolCall row. **Pages are stored-only**: `getForDay` never reads Gmail for a missing day, the Gmail page
does not auto-build today on open (it says when the brief is written and offers "Refresh now" — an
explicit, counted call), `hints.gmailUnread` comes from the stored brief. **The cap**: `gmail.dailyCap`
Setting (default 60, 0 = off) is enforced inside the ONE call path `GoogleWorkspaceService.call()` for
toolkit gmail, counted from local midnight (`startOfLocalDay`) over ToolCall rows that reached the vendor
(`gmail-cap` / `not-connected` rows do not count); past it the call is written down as `gmail-cap` and
throws `gmail-cap:<calls>:<cap>` → the controller's plain sentence. `GET /api/google/gmail/usage` and
`PUT /api/google/gmail/cap` feed `GmailUsageLine` (Google home + Settings → Google, editable there).
Traps: a spec harness needs `prisma.setting` + `toolCall.findMany` + `gmailBrief.findFirst/update` now
(`google-workspace.testing.ts` `build()` carries them); `nowSeconds()` exists so a spec can pin the clock;
the cap is a count-then-call, so two Gmail calls fired together (`readDay()`'s unread + list) can land at
cap+1 — accepted for a daily cap, not a bug to "fix" with a lock; a failed address probe backs off 6 h in
memory (`emailProbeFailedAt`) and the address is keyed to the account id (`google.emailAccount`), so a
reconnect learns the new address once; `startOfLocalDay` reads the zone offset at `now` (an hour off on a
DST-change day in a DST zone — IST has none).

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
(mode raw, a "Union" — since BEA-1374 `mergeTables()` de-dupes on the item id column across sources; anything more is the shaping step's job) when >1, the `ask_ai` shaping node ONLY when `wantsShaping()` AND mode is
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
**pages** — `_pages` beside a source's args in `toolArgs` (1..11, default 1; `plainArgs()` strips `_`-keys before the vendor sees them): `fetchSource()` sends
page 1 as always, then the vendor's cursor (`nextCursorOf`: cursor · next_max_id · end_cursor…) or the next page number under the param the
know-how card's `paging.field` names (else inferred from the answer's cursor key, else a `page` already in the args, else "does not page"),
ONE `ToolCall` per page with its credits, items de-duped on `dedupeKey()` (`itemKey` id fields, never position), early stop on no cursor /
an empty (not_found) or repeated page, and `SocialBudgetService.check()` before EVERY page; a later page that fails for any other reason
FAILS the run (nothing written). One page = the raw answer as before (a profile stays a profile); several = `{[listKey]: items}`. Step:
"Fetched Instagram · Popular Search — 96 items over 8 pages · 8 credits · stopped early: page 9 was empty". A Watch keys its baseline on
the plain args, so more pages never forgets a baseline. **creators-first** — `toolArgs[<source id>] = { kind:'creators', find:{actionId,
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
false}` — what a private/empty account answers, seen live) → 0 items, never one row of envelope; a single-object answer is ONE row via the same
`unwrap` plain sources use — `{success, data:{user:{…}}}` IS the profile (BEA-1377: `data` is also a LIST_KEY and the old name-only check counted
101 succeeded profile calls as "0 items"; the step now reads "N profiles fetched · N rows", and the tripwire `unrecognisedAnswer` makes the step say
"fetched N answers but recognised 0 rows — this is a My Brain bug, not the vendor" whenever data arrived that no shape here could read; and `findList`
runs only at the TOP of an answer — inside the wrapper it digs a profile's own `bio_links` out as "the list", which wrote 2 title/url junk rows per
linked creator and LOST those profiles on the first live re-run) — and the date field is decided over EVERY creator's items together, or the first
empty account switched "last 30 days" off for everyone (found on the first live creators run).
Traps: `SocialAgentRunService`'s constructor gained `knowledge?: ToolKnowledgeService` LAST (positional harnesses); the finder id doubles as
the block's key, so one job holds one creators block per finder action; `_pages` on an action that does not page costs one call and the step
says "this endpoint does not page (5 pages asked)".

**The builder may look for itself — capped sample calls (BEA-1370, `specs/THINKING-BUILDER.md` §B).** `BuilderSampleService`
(`api/src/agent/builder-sample.service.ts`): `sample(sessionKey, actionId, args)` → `ServiceActionsService.runDetailed()` with
`runKind:'builder'`, `argsPinned:true` (the ordinary `ToolCall` row, `runId` = the conversation's Setting key — so the know-how card's
observed part learns from it with nothing extra) → a **compact view** `{ ok, actionId, name, args, count, listKey?, fields:[{path,kind}]
(item-relative, the card's own `fieldsOfValue` walker), hasDate, items:[≤3, 700 chars/cell — `tableOf` rows], credits, ms, error?,
notFound?, refused?, budget }`. **Reads only, decided by the catalog's own rules** (`provider.readOnly` · `action.method==='GET'` ·
`isReadAction`; `action.risky || isRiskyAction` refuses first): a write, a risky/gated action or an action it cannot load is refused
BEFORE any call with a plain reason (`refused:true`, no `ToolCall` row) — a `GatePause` can never surface in a builder. **Caps per
conversation** — `SAMPLE_CAPS` in `builder-session.ts` (3 calls, 5 credits; the credit check uses the action's last cost, else 1):
over → `sample budget used (3 of 3 samples · N of 5 credits) — ask me instead`. The counter is `samples:{used,credits}` INSIDE the
builders' own `Setting` row (`builderSettingKey(sessionKey)`: `TOP_BUILDER_SESSION` → `agent.builder`, an area id → `agent.jobBuilder.<id>`),
reserved BEFORE the call, carried through every chat turn by `AgentAreasService`' load/save, and dropped by the existing reset routes
(a fresh conversation is a fresh budget). The daily Social ceiling is checked first (`SocialBudgetService.check()`), and it reaches the
service through `setBudget()` at boot (SocialModule imports AgentModule — the `setFlowSync` pattern). Every ATTEMPT (success or vendor
failure) appends one `{who:'ai', kind:'sample'}` line the owner reads — `sampleLine(view)` (pure): `🔎 I tried Instagram · Popular
Search (query: home automation) — 12 posts · fields: id, caption, owner, url… · no date field · 1 credit` / `… — no luck: <plain reason>
· 0 credits`; refusals are handed back to the caller, not logged. Routes: `POST /api/agent/builder/sample {actionId, args}` and
`POST /api/agent/areas/:id/job-builder/sample` → the view (HTTP 200 even when refused — it is an answer, not a crash). The builders
themselves are wired to it in ④ (BEA-1371). Trap: `runDetailed()`'s `keepKnown()` drops any argument the action's schema does not name,
so a misspelt argument is silently dropped and the sample runs without it — the view's `args` are what was ASKED, the `ToolCall` row's
`arguments` are what really went out.

**The thinking builder — the two chat builders design from facts, not a script (BEA-1371, `specs/THINKING-BUILDER.md`).**
`AgentAreasService.builderChat` / `jobBuilderChat` share ONE turn engine (`think()`), and every design turn runs on
`completeHelper('agent-builder')` — Sonnet 5 via OpenRouter, Settings → Agents & Engines "Agent builder model" — never Codex
(Codex only delivers) and never a cheaper model (the owner's rule). The pure parts live in `api/src/agent/thinking-builder.ts`:
the prompt gets (a) the conversation, (b) the **facts section** — `shortlistForPrompt` → `pickCardIds` (≤50 `svc:` ids: keyword score
+ `NAMED_SERVICE_BOOST` for a service the owner NAMED by exact slug, ≤20 per service — the first live turn lost Instagram's own
`user_posts` to 36 Google Sheets actions that matched "sheet"; the Sheet is the plan's output block, not a source) →
`ToolKnowledgeService.lookup` → `cardText()` per card in FULL (params, fields with kinds, has-a-date, paging, cost, health, notes),
most relevant first under `FACTS_CHAR_BUDGET`, then `indexSection()` — the other shortlisted ids as "id — name" so the model knows
they exist and can sample one; a plan may use any id it was shown (card or index), never one it made up; non-service tools stay
one-liners in `{{tools}}`, (c) `BLOCKS_TEXT` (the BEA-1369
blocks + cost rules, incl. "several sources may use the SAME action" since BEA-1374), (d) `SAMPLE_TEXT` — the model may answer `{sample:{actionId,args}}`
and the server runs `BuilderSampleService.sample()` (③'s caps hold, the 🔎 line lands in the log because the sampler writes the same
row — `think()` re-loads the row after each sample) and re-prompts with `sampleViewText()`; at most `SAMPLE_LOOPS_PER_MESSAGE` (3)
rounds per owner message, then a forced answer, (e) `RULES_TEXT`, and the design budget line. **Budget:** `DESIGN_BUDGET` (12 turns / 400k ≈ tokens per
conversation — a sampled turn is ~50k ≈ tokens live, 5 model calls over the facts; `TURN_MAX_TOKENS` 8k out because the first live
turn was CUT OFF at 4k and a cut JSON is a lost turn — `parseBuilderJson` salvages the reply; `design:{turns,tokens}` in the builders'
Setting row, dropped by reset) — over it the prompt says
"DESIGN BUDGET SPENT … give the plan now" and, if the model still asks, the last saved plan comes back as the reply. **Output** is
`{reply, sample?, plan?, cost?, spec?|job?}`; a `plan` goes through `validatePlan(raw, allowedIds)` (ids outside the shown cards are
"invented" and refused; one bad plan is sent back ONCE with the reasons, then reply-only) and is made canonical by
`planFromAgent(planToAgentInput(draft))` — so the plan shown IS the plan created; `cost` = `estimatePlanCost(plan, cards)` server-side.
One proposal at a time: a plan clears the ordinary `spec`/`job` and the other way round. **Create:** `builderCreate`/`jobBuilderCreate`
with a plan → `createAgent(planToAgentInput(plan))` (tools + toolArgs incl. `_pages`/creators blocks, task, mode/threshold/condition,
outputDest/sheetId, notifyWhatsApp, schedule, `origin:'social'`, `category:'Social'` when every action is the social provider's) — the
flow picture then draws itself (BEA-1366); the ordinary spec/job path is untouched. `healthNote()` appends a plain note when the plan
uses a source whose card says FAILING and the reply did not say so. **The goal interview (BEA-1378):** the builder settles what the
result is FOR before planning (`RULES_TEXT`'s goal rules — the goal decides the shape, a literal-ask/goal mismatch is said before
planning, a stated goal is never re-asked); the model's `goal` field is kept in the conversation state, returned beside `plan`/`cost`,
shown as the card's first "For:" line and carried onto the created agent's description (`withGoal`), and an EXPENSIVE plan
(≥50 credits or ≥100k AI tokens by the server's own `estimatePlanCost`) with no goal established is stripped to reply-only exactly
like the healthy-source rule (`isExpensivePlan`/`noGoalText`/`goalMissingNote`). Prompt defaults `agent.builder`/`agent.jobBuilder` carry the
`{{facts}} {{tools}} {{blocks}} {{sample}} {{budget}} {{rules}}` slots; `fillTemplate()` APPENDS any slot an owner's older Settings
override lacks, so an override never loses the facts. UI: `web/src/ui/PlanCard.tsx` (small plan-with-cost + Create in both chats until ⑤);
NewJobChat must NOT plan a flow after a plan-create (the server drew it). Traps: `AgentAreasService`' constructor gained `sampler?`
and `knowledge?` LAST; the recorded-answers test picks its fixture by `OWNER: …` in the conversation, not by words that also appear in
`BLOCKS_TEXT`; several search terms on the SAME action ARE possible since BEA-1374 (sources are keyed by source id, see the next paragraph).

**The builder's screens (BEA-1372): the plan-with-cost card, sample rows, and every entry point through the builder.**
`web/src/ui/PlanCard.tsx` is the real card both chat builders draw (`AgentBuilder`, `NewJobChat`): Fetches (one line per source —
`sourceLine()`: action · args · "× N pages"; creators-first "Find creators with … — the first N → each one's posts, last N days"),
Keeps (watch/alert words + the shape prompt, else "rows as fetched — no AI step"), Goes to (`outputText()`), When, Tells, then
`costLine(cost)` = "≈ N credits · ≈ Nk AI tokens ≈ ₹N per run" (or "· no AI cost") with a **how** fold that shows the server's
`cost.how` — never a client guess. `estimatePlanCost()` now returns `aiRupees` (`rupees(aiTokens)` at `RUPEES_PER_1K_AI_TOKENS`
= ₹0.30, stated inside `how`). **Unhealthy sources are marked from data**: `think()` puts `unhealthySources(plan, cards)` on
`cost.unhealthy` (`{actionId,name,note}[]`, `healthNote()` writes the reply's note from the same list) and the card draws
"<name> is down at the vendor right now — kept so it fills in later" under that source (`data-testid=plan-source-unhealthy`).
Buttons: **Create** (`plan-create`) · **Change something** (`plan-change`, focuses the chat textarea through a wrapper ref) ·
**Not now** (`plan-dismiss`, hides the card locally; "Show the plan again" brings it back; the plan stays on the server and
the next reply un-hides it). Create → `withCreatedFlag(url)` = `/agent/a/<id>?created=1` and `AgentApp` shows a one-time
"Created. Run it now?" banner (`created-banner`, Run now / Later; both drop the flag). Chat rows: `web/src/ui/BuilderMessage.tsx`
draws every log line — a `kind:'sample'` line (or a leading 🔎) is its own muted dashed row (`builder-sample-row`, the text as
the server wrote it, never a JSON wall), a `kind:'seed'` line is the builder's bubble tagged "from your Social run"; after each
turn both chats RE-READ their state row so the 🔎 lines the turn wrote land in order before the reply. **Entry point (b):**
"Make it an agent" on a Social result now goes to the THINKING builder — `makeAgentUrl()` in `SocialPlatform.tsx` →
`/agent?builder=chat&tool=&args=&label=&sample=<{count,listKey,fields,credits,notFound}>` (`readBuilderSeed()` in `Agents.tsx`;
`readSocialPrefill(params, kinds)` reads the same tool/args for either kind) → `AgentBuilder` with a `seed` POSTs
`/api/agent/builder/seed` (`AgentAreasService.builderSeed`): a FRESH conversation whose first line is scripted by `seedLine()`
("You just ran Instagram · Search Hashtag Posts (hashtag: smarthomeindia) and got 8 posts for 1 credit. Is this the kind of
thing you want, and how much of it? …") — no model call — and `seed` (id + exact args + compact answer) is stored in the
builder's Setting row and rides into every later turn's prompt as the "Where the owner came from" section (`seedText()`,
appended by `fillTemplate` — no prompt default change). The same seed again is a no-op (a reload must not wipe the talk;
`onSeeded` also drops `sample` from the URL), a different call starts over, Create/reset drop the seed. The pre-filled form
(BEA-1357, `builder=1`) is still one tap away as **"Repeat exactly this call"** (`repeat-exact-call`: sets `builder=1`, opens
`NewAgentForm` with the same prefill). Entry point (c) — Chat "make this an agent" — is NOT done: the chat's `ToolChip` carries
`actionId` but not the arguments the model chose (`ChatToolsService.execute` goes through `actions.run()`, not `runDetailed()`),
so a hand-off there would seed an empty call; it needs the chip to carry args first. Traps: `AgentApp` and the job page still
read `PlanCost` without `unhealthy` (only the builders' `think()` adds it); the sample re-read after a turn means a test that
stubs `/api/agent/builder` must return the FULL log, or the reply is appended locally as before.

**Sources are keyed by SOURCE id, so five hashtags on one action are five sources; "keep adding" means append to ONE sheet (BEA-1374).**
`Agent.toolArgs` is `{ [sourceId]: { actionId, args, _pages? } | { kind:'creators', find, then } }` — the source id is the action id for the
first source on that action, then `<action id>#2`, `#3`… (`sourceIdFor`; readable in the node id `src:svc:instagram.search_hashtag#2`).
The OLD shape `{ [svc id]: args }` (every job saved before 2026-08-18) is read TRANSPARENTLY by the ONE pure reader `normaliseToolArgs()`
in `api/src/social/tool-args.ts` (mirror: `web/src/ui/toolArgs.ts` — keep them in step): `planFromAgent`/`sourcesOfAgent`, `isDirectFetchAgent`,
the runner, the flow drawer, the cost, `planToAgentInput`, `agent.service.ts` (create/update WRITE the new shape — `shapeAgent` returns it too,
so the API always answers the new shape — and `tools` is recomputed with `toolsFor()` = the input's tools ∪ every action the sources call, a
`#n` source id dropped), the builder form and the job Settings (`sourcesOf`/`toolArgsOf`/`toolsOf`). `Agent.tools` keeps meaning "the action ids
this job may call" (deduped); the sources are the truth for what runs. Order: `tools` order by action, then storage order — identical for
every pre-1374 job (a locking test replays the owner's live agent `83ff0b15…` before/after). In the runner the merged table's `source` column and
the step labels carry the telling argument ONLY when the action repeats (`sourceLabel`/`sourceHint`: "instagram.search_hashtag · smarthomeindia",
"Fetched Instagram · Search Hashtag Posts (smarthomeindia)"); a lone action reads exactly as before. A Watch baseline row stays keyed on the
ACTION id (`SocialWatch.actionId` = `sourceActionId(s)`) + args, so no pre-1374 baseline is forgotten. `mergeTables()` now de-dupes across
sources on the union's key column (`KEY_FIELDS` order: id, pk, shortcode… url) — the merge step says "N duplicates across sources dropped
(matched on "shortcode")". The flow node label carries the hashtag/query when the action repeats ("Instagram · Search Hashtag Posts
#smarthomeindia × 3 pages"). **Keep adding** = `Agent.sheetAppend` (new column, migration `agent_sheet_append`) → `plan.output.append:true`
with no `sheetId` yet: the first run creates ONE sheet titled with the job name (no date), writes, and `updateAgent(id, { sheetId })` remembers it
on the job (a failure to remember FAILS the run and says to paste the link — never a quiet second sheet); every later run reads the header +
count as before AND, when the header has a key column, that column (`readSheet(..., { keys:true })`, one extra Sheets read, never a Social
credit) and `dropSeenRows()` skips rows the sheet already has ("Appended 3 rows (3 already in the sheet — skipped, matched on "shortcode")";
all already there → done "Nothing new", no write, WhatsApp skipped). The engine road's `deliverTextToSheet` and a Watch do not read keys (a Watch
already writes only what is new). UI: `OutputDestPicker` has a "Keep adding to one sheet" switch (shown for sheet + no sheet id; the builder
form POSTs `sheetAppend`, the job Settings PATCH it); `AddSourcePanel` no longer greys out an action already on the job — it says "adding it
again with different arguments makes another source" (`data-testid=same-action-note`). The builder's `BLOCKS_TEXT` says several sources may
use the SAME action; `RULES_TEXT` maps keep adding / accumulate / grow the list → `output.append:true` on ONE sheet; `validatePlan` accepts
repeated action ids (unique source ids via `sourceIdFor`) and reads `output.append`; `planToAgentInput` emits `sheetAppend` and the new
`toolArgs` shape. Traps: `new Set(iterable)` with an `Iterable<string>` parameter in `tool-args.ts` made tsc report `never` errors in three
UNRELATED files (a TS inference-cache quirk) — the parameter is `string[]`; `AgentFlowSyncService.SOCIAL_KEYS` includes `sheetAppend`, so
flipping it redraws the picture ("Google Sheet — one sheet, kept adding to" → "append to yours" once the runner remembered the sheet).

**Lessons from the acceptance run: the builder plans on a HEALTHY source first, samples a finder before trusting it, settles when/where before
the plan, and the cost line is the server's (BEA-1375).** The BEA-1373 run got there only because the owner pushed four times
(`.claude/checks/ui-shots/BEA-1373/transcript.md`); each push is now a rule in `RULES_TEXT` (judgement rules from the facts, no fixed
interview): a plan needs one source that can produce rows TODAY; sample the finder before a creators block and judge the accounts real
(followers, posts — look-alike handles with 0–20 followers are not creators; try Popular Search owners / native user search and say what
you tried); "when it runs" and "where the rows go" are open until said or accepted in so many words; cost numbers are the server's, never
the model's. Where the server can check, it does — `think()`'s loop sends a plan back at most ONCE per reason, `MAX_ASKS_PER_MESSAGE` (7)
model calls per owner message all in: (1) **no healthy source** (`planHasHealthySource` in `plan.ts`: a block is healthy when none of its
actions is `isFailing` = health known + not ok; no verdict counts as healthy) → `noHealthySourceText`; still none → the plan is NOT shown
(reply only) and `healthNote()` says "Nothing in this plan can produce rows today — every source in it is failing … I have not shown it as
a plan yet" — NEVER "the other sources carry the run" when there are none (that sentence stays for a plan with a working source beside the
failing one, and is skipped when the reply already says "down"); (2) **unsampled finder** — the sampler's log line now carries `actionId`
(`sampledActionIds(state)` reads those lines + the Social hand-off seed; `unsampledFinders(plan, seen)`) → `sampleFinderText` nudge, only
when the sample budget has room (`SAMPLE_CAPS`, `overBudget`), so the model answers `{sample}` and the SAME loop runs it; (3) an invalid
plan, as before. **Cost:** `estimatePlanCost` returns `nowCredits` (healthy sources only — a failing source's pages are not counted, a
failing finder finds no one, a failing per-creator action leaves the finder's credit) and fills `unhealthy` itself when the knowledge
carries `name`+`health` (`CostKnowledge` grew those; `costWithHealth` is just the estimate now; `social.controller` passes them too, so the
job page header says it); `how` gains "(≈ 11 credits today while Search Hashtag Posts is down — a failing call answers empty and is not
charged)"; `creditsText(cost)` = "≈ 19 credits (≈ 11 while Search Hashtag Posts is down)" only when they differ (mirror in `PlanCard.tsx`
`creditsText`/`downText` — keep in step; `AgentApp` header uses it); `costLineText(cost)` is the whole card line, and `think()` APPENDS
"Cost: <costLineText>." under every reply that shows a plan (`costReplyLine`) — the reply and the card can never disagree again — and the
next turn's prompt carries "Server cost of that plan (quote these, not your own)". The prompt defaults' reply slot no longer asks for
"≈ credits and ≈ AI tokens" in prose (the JSON `cost` field keeps the model's arithmetic). Know-how notes completed: `search_profiles`
"Matches names/handles, not topics — many look-alike/dead accounts … Sample before trusting", `search_popular` "Owners of popular posts are
a good creators finder … argsFrom { handle: owner.username }". Traps: the five-hashtags recorded test now runs on a WORKING hashtag card
(a plan of only failing sources is refused by design); a harness with no `sampler` never nudges for a finder (it cannot run one).
The first live re-run after this shipped spent all 3 samples re-checking hashtag/reels search the cards already said were FAILING, then
planned creators-first on an unsampled `search_profiles` with no budget left — so `RULES_TEXT` now says a FAILING card IS the answer (keep a
sample for the finder), and when a plan's finder was never sampled and cannot be now, `think()` appends `unsampledFinderNote` ("I have not
looked at X myself … judge the first run's rows") — the builder never claims accounts are real that it has not seen.

**Owner WhatsApp alerts check Meta's REAL verdict — refused → the same alert on Telegram (BEA-1379).**
Postbox answers `sent` before Meta decides; a template to the owner when he has stopped engaging is refused
2–7 s later ("This message was not delivered to maintain healthy ecosystem engagement") and the old code
reported "WhatsApp sent (template)" while his phone stayed silent. `sendOwnerAlert` (`api/src/contacts/
owner-alert.ts`) now (a) tries the template CHAIN `ownerTemplates()` — `mybrain_result_v1` (2 variables:
name + one-line result; pending at Meta as of 2026-08-20) then `mybrain_update_v1` (3 variables); a
`templateUnusable` answer falls through to the next name, any other verdict stops the chain — and (b) keeps
Postbox's message `id` off the send and polls `PostboxService.messageStatus(id)` (Postbox's app-key route
`GET /v1/messages/:id/status`) after `VERDICT.waitMs` (8 s, one retry at +8 s while still `sent` — the
constants live ONLY in `VERDICT`; tests set `waitMs` to 0). `failed` → the SAME alert goes out on Telegram
and the step says exactly `REFUSED_ON_TELEGRAM` ("WhatsApp refused by Meta (engagement pacing) — sent on
Telegram instead."); delivered/read → nothing extra; status route unreachable → the step says "WhatsApp
sent (template) — delivery unconfirmed"; still `sent` after both polls → the plain label stands. The
Telegram road is `TelegramService.notifyWhatsAppRefused`, registered at boot through
`setOwnerAlertTelegram()` — a plain-function seam in owner-alert.ts, because PushModule/ContactsModule can
NEVER import TelegramModule (Telegram → Daily → Mentor → Push, never back). A Watch/Alert push already
carries Telegram itself, so `AlertsService.runFinished(..., { kind: 'alert' })` passes `telegramCarried`
and a refusal only SAYS "already went out on Telegram" — never a second push. Contact reminders (other
people) are untouched — they deliver fine. Trap: a spec stubbing `sendTemplate` without `messageStatus`
never polls (old behavior); a stub WITH it must answer per poll or the test really waits.

**WhatsApp is the THIRD provider on the seam (BEA-1384).** `WhatsAppProvider` (`api/src/tools/
whatsapp.provider.ts`) wraps our own gateway's MCP server (streamable HTTP, stateless POST JSON-RPC,
answer = JSON or one-event SSE — both parsed): `tools/list` is read at boot/daily/refresh (last good
copy on disk under `DATA_DIR`) and every action is generated from it — ids `svc:whatsapp.<tool>`,
NEVER the gateway's name (the seam rule). Auth = `WHATSAPP_MCP_TOKEN` in deploy.sh (a Postbox team
token, `tm_…`, minted in Postbox → Team; the "My Brain" one sends from +91 78938 20808) — env only,
never in code/DB/logs; without it the provider is honestly not-configured (tile marked, runs refuse,
no fake success). **Gating map:** `send_template · send_text · send_list · send_rfq ·
delete_template` carry `risky:true` and stop at the can't-undo gate; every read and
`create_template`/`generate_pdf` run free; `isRiskyAction()` runs on top so a future `delete_*`
tool gates by name. Reads carry `method:'GET'` so the builder's sampler recognises
`broadcast_status`/`get_stats` as reads. It joins the catalog's **Social** group
(`loadSocialFrom()` builds both providers side by side, `risky` carried), `ServiceActionsService.
providerFor` routes `svc:whatsapp.*` to it (Composio BLOCKS the whole service — ours), the know-how
cards fetch from it (`tool-knowledge.service.ts`, notes in `knowledge-notes.ts` carry the 24h-window
/ APPROVED-template truths), and `/social` shows it as one more platform: `metered:false` (no
credits, no credit strip, never "cached · 0"), its OWN `connection` state on the platform page (the
scraping key being missing must not grey it out). A gated send from the Social form answers a
`gate` shape (not an error) → confirm card → `POST /api/social/gate` re-runs with the EXACT
approved args (same runId/nodeId contract as Chat's card). A send the gateway reports `status:
"failed"` (Meta's async refusal, 24h window, unapproved template) FAILS the step with Meta's real
reason — "sent" only means "handed to Meta". Traps: the direct Social runner does not catch
`GatePause`, so a send inside a direct-fetch agent fails the run honestly ("Held for your
approval…") — the flows road is where a send pauses durably; `list_templates` etc. are 16 tools on
the live server (fixture `fixtures/whatsapp-mcp-tools.json`).

**The agent engine**
Agent runs execute on **Codex directly** via a host runner at `http://172.18.0.1:8765` (`/home/sandy/codex-runner/server.js`) — Hermes was removed in 2026-06. The runner only takes a prompt; it offers **no per-run tool gating**, which is why the toolbox is enforced on our side (`flows-runner` refuses a step, the prompt declares the allowed set). My Brain's own tools reach the model as a host **MCP server** (`~/.codex/config.toml [mcp_servers.mybrain]`), mounted statically for every run.

**NEVER mount a search tool on an engine turn** (BEA-1202). Exa's hosted MCP was registered here in BEA-1196 so engine turns "could search too" — which reopened the door BEA-1194 exists to close. A model with its own search decides *how* to search, spends outside our budget, and is invisible to `FlowRun.spend`. It has been removed; `codex mcp list` must show only `mybrain`. The same applies to any engine added later.

**Web search is NOT an engine turn.** `web_search` / `web_read` (Tavily), `web_search_meaning` (Exa) and `deep_research` are direct calls in `api/src/tools/` (`web-research.service.ts`, `deep-research.service.ts`), dispatched inside `runNode` — they are deliberately absent from `AGENT_TOOLS`. Putting them back would hand the choice of *how* to search to the model, which is the bug that made a research run cite 2021 figures for 2025. They never fall back to the model: a failure fails the step with its reason.

**Deep research is ours, and it is budgeted.** `deep_research` (BEA-1196) plans sub-questions, runs the searches itself, reads pages and writes the cited report on the **flat-rate** engine — the `deep-research` entry in `LlmService.HELPERS` defaults to Codex on purpose, because the point was that a report costs only search credits (~30c) instead of Perplexity's ~$1–2. Hard caps live in `deep-research.service.ts` (`HARD_CAP`: 24 searches, 10 page reads — raised from 8 in BEA-1239, when every question started sweeping all three indexes) and no node setting can exceed them. What a run actually spent is stored on `FlowRun.spend` and shown in the Runs list.

**Whole vendor answers are kept, so a worker can be tested and repaired for free (BEA-1386, agent
workers 1/10 — `specs/AGENT-WORKERS.md` §A).** `ToolCall.result` is pretty-printed then cut to 2,000
characters, which is why nothing could be replayed. `ToolSample` (new table, migration
`20260822090000_tool_sample`) keeps the answer WHOLE: masked, gzipped, a **BLOB — never base64** (the
nightly backup copies the database whole). Written from the ONE call site,
`ServiceActionsService.runDetailed()`, beside the `ToolCall` row, on success only, through
`ToolSampleService.maybeKeep()` (`api/src/tools/tool-sample.service.ts`) — optional + last on the
constructor, never throws, so a harness without it behaves exactly as before. **Sampling is opt-in per
service and never keeps anybody's messages**: `shouldSample()` in `tool-sample.ts` wants a successful,
ungated READ of a service in `SAMPLE_SERVICES` (instagram · tiktok · youtube · twitter · linkedin ·
facebook · threads · reddit) **that the public-scraping provider actually served** (`providerKind ===
SAMPLE_PROVIDER`, decided at the call site by which provider `providerFor()` picked — the general
provider has its own `twitter` signed in to the owner's OWN account, and reading his followers is his
address book, not public content), and `NO_SAMPLE_SERVICES` (vault · whatsapp · gmail · chat · slack ·
telegram …) plus `NO_SAMPLE_ACTION_RE` (message/dm/inbox/conversation/mail on the ACTION half only —
the Threads platform is not a conversation) say no over the top of it. **`maskPayload()` is NOT
`redact()`** — that one cuts at 4,000 characters and masks by key name only, so it would miss a phone
number in `wa_id` or an e-mail in a caption. The new one has no cap and masks by key name AND value
shape everywhere, including inside free text: e-mails, E.164, and any run of digits and separators
whose DIGIT COUNT is 10–14 (`PHONE_RUN_RE` — "98765 43210" and "9876-543-210" are how a bio really
writes a number, and matching only unbroken runs missed them); ids
(`ID_KEY_RE`) and dates (`DATE_KEY_RE`) keep their digit runs on purpose — an Instagram `pk` IS a long
number and a masked `taken_at` would break "the last 30 days". Caps, in one place: `RAW_MAX` **2 MB**
before gzip (bigger → stored truncated, `note` starts `truncated:`, `isUsable()` false, `replay()`
skips it — it was 256 KB until BEA-1395 measured a real Instagram profile answer at 436 KB, which
meant every answer the owner's flagship job gets was kept truncated and unusable), `SAMPLE_MAX_BYTES` 1 MB stored, `PER_ACTION_GOOD` 5 per (actionId, argsHash),
`PER_AGENT_FAILING` 10, `TOTAL_BUDGET_MB` 100. The 6-hourly sweep evicts per shape → per job → oldest
first, then runs `PRAGMA incremental_vacuum` — the migration sets `auto_vacuum = INCREMENTAL` (and
VACUUMs once) because **SQLite otherwise never gives the space back and the nightly backup grows for
ever**; `tool-sample.store.spec.ts` proves it on a real database (55 MB in, 50 evicted, the file
measured before and after). `replay(actionId, argsHash?)` returns the parsed payload and **has no
provider to reach** — a repair loop costs nothing. `setPinned()` is the hook for a worker's
`samples/index.json` (nothing registers one until the workers land; a hook that throws makes the sweep
delete nothing that pass).

**A worker calls back in, and every call it makes is journalled (BEA-1387, agent workers 2/10 —
`specs/AGENT-WORKERS.md` §B, §C, §H).** The fetch now lives in ONE place: `SourceFetchService`
(`api/src/social/source-fetch.service.ts`) holds `fetchSource`/`fetchCreators` exactly as they were,
and `runPlan()` was switched onto it in the same issue — two copies of paging is the failure this
whole design exists to prevent. `SocialAgentRunService` builds one for itself when a harness leaves
it out (the `ServiceActionsService.gates` pattern), so every positional spec still works; the pure
helpers (`itemsOf`, `unrecognisedAnswer`, `isEmptySearch`, `nounOf`) moved to `social/source-fetch.ts`
and are re-exported from the runner. **The callback API** is `api/src/worker/` — `POST /api/worker/
{tool,merge,ai,step,output,notify,ask,finish}`, `@Public()` so the global `AuthGuard` steps aside,
behind `WorkerTokenGuard`, which accepts ONLY a run-scoped token: an owner's browser session (cookie
or EMO device token) reaches nothing, and `runId`/`agentId` come off the token, never the body.
Tokens are minted per **spawn** (`WorkerTokenService`, in memory, 20 min, revoked at finish AND at a
pause — a token's life is minutes, never the days a question waits) and minting sets
`AgentRun.runKind='worker'`. `POST /tool {sourceId}` does the **whole paged, de-duped fetch
server-side** (a worker has no database, so it can never decide paging that depends on know-how
cards); `POST /ai` runs the app's own `shape()` when it is given rows, and otherwise only the
allow-listed helpers (`social-shape`, `social-alert`); `POST /output` goes through the new shared
`writeRowsToSheet()`/`writeDocument()` that `runPlan()` now uses too. **The journal** (`RunJournal`,
migration `20260822120000_run_journal`) is what makes waiting free: every effectful call is
`once(runId, seq, fn, args)` keyed by `stepKey = sha256(seq + fn + argsHash)`, so a resumed worker
re-runs from the top and its earlier calls return recorded values — zero repeat fetches, zero repeat
sheet writes, zero repeat messages — and a call order that CHANGED between replays throws
`NOT_REPEATABLE` instead of doing a step twice. `seq -1` holds the run's seed (frozen `now` +
random), so `installDeterminism()` can point the worker's `Date.now`, `new Date()`, `Math.random`
and `crypto.randomUUID` at it and two spawns take the same road. **`AgentRun.runKind`**
(`engine|worker|plan`, default `engine`) and `HermesBridgeService.resumeTick()` now skips anything
that is not `engine` — without it a parked worker either strands for ever (`sessionId` null) or
wakes as a live Codex turn (`sessionId` `''`). **The kit** is `api/src/worker/kit/kit.js` — plain
CommonJS with named exports so a generated ESM `worker.mjs` can `import { makeKit }` from it (proved
by a test that really loads it in Node); every function is a thin call back in, so parity is by
construction and the **parity suite** (`kit-parity.spec.ts`) proves it: the same saved `ToolSample`s
→ the same rows out of the worker and out of `runPlan()`. Deliberate differences from the §B sketch:
there is no `kit.creatorsFirst(find, then)` — a creators block is fetched by its **source id** like
any other source, because the plan already holds it; `kit.merge` has its own tiny route because
`mergeTables()` may not be re-implemented in a worker; `kit.watchDiff`/`kit.expect` are NOT here
(contracts are piece 6). Automatic checkpoints are `AgentService.stampProgress()` — ONE live line
that updates itself (never fifty), stamped every page and every creator by the fetcher itself, which
is what the piece-7 stall watchdog will read. Traps: `main.ts` already calls `setGlobalPrefix('api')`, so the controller is `@Controller('worker')`
— declaring it `api/worker` answers at `/api/api/worker` and every call 404s (found live, seconds
after the first deploy; a test now reads the path metadata); `SocialAgentRunService`'s constructor gained
`sources?` LAST; the worker routes are exercised in-process (`worker-harness.testing.ts`) because
the worker runner is piece 4 — nothing spawns a process yet.

**One run at a time per job (BEA-1388, agent workers 3/10 — `specs/AGENT-WORKERS.md` §G).** Nothing
stopped an agent running twice at once before this: `AgentScheduler.tick()` deduped only on
`lastFiredKey` (one fire per minute-slot) and runs are fire-and-forget promises, so a manual tap
during a scheduled run started a second run over the first — sharing one Watch baseline, one "keep
adding" sheet and one credit ceiling. `RunLockService` (`api/src/agent/run-lock.service.ts`, exported
from `AgentModule`) is one `JobRunLock` row per job, `jobId` **UNIQUE**, and that uniqueness IS the
claim: an `INSERT` either lands or the database rejects it (P2002), and taking over an expired lock is
ONE conditional `UPDATE … WHERE jobId = ? AND expiresAt <= now` — **never read-then-write**, which is
the race itself. Only the holder releases (`DELETE … WHERE holder = ?`), so a holder back from the
dead cannot free the run that replaced it. **The claim lives in `HermesBridgeService.startRun()`** —
the one door the scheduler, both manual routes, event triggers and voice all come through — and it
happens BEFORE the run row is created, so a loser leaves no junk run in the owner's history. The
worker road claims at `WorkerTokenService.mint()` instead, because a worker is spawned again after
every pause: the same run re-claims (pushing `expiresAt` out), a different run of that job is refused.
**A job has a second door and it is locked too**: the Flow tab's Run (`POST /api/flows/:id/run` →
`FlowRunnerService.start()`) claims the same lock whenever the flow carries an `agentId`, and gives it
back in `freeJob()` — called when the driver settles, on cancel and by the flow boot reconciler, and it
checks the row's status first, because a driver settles on a **pause** too and a `waiting` flow is still
a run. A standalone flow (no `agentId`) and an eval run (`flowId: null`) are not jobs and are never
locked. An event trigger that finds the job busy says so on the run that is still going, exactly like
the scheduler.
**Terminal state = release**: `AgentService.finishRun()` (any of done/failed/cancelled), `cancelRun()`,
the boot reconciler (a restart frees the jobs it orphaned) and `deleteAgent()` (no FK, by hand, like
`SocialWatch`). **A second start is never silently swallowed**: a manual tap gets `JobBusyError` →
**HTTP 409** with a plain sentence in the toast, and a scheduled fire is **skipped, not queued and not
duplicated**, with the reason written as an `info` step ON the run that is still going ("Skipped the
08:00 start — this run was still going") plus a log line; the slot still counts as fired, so the same
minute is not retried. **`TTL_MS` is 30 minutes**, and it is the ONLY safety net until the piece-7
stall watchdog: longer than any real run (an engine turn is capped at 250s; the longest paged/creators
plan run is minutes) and longer than that watchdog's 20 minutes so the watchdog gets there first and
releases properly, but short enough that a crash costs one fire instead of wedging a job for ever — a
run parked on a question does not release, so the expiry is also what stops a 12-hour wait blocking
the schedule. Proved against a REAL SQLite file (`api/src/agent/run-lock.spec.ts` — 20 racers, one
holder) and over real HTTP on a running app: three simultaneous `POST /api/agent/agents/:id/run` →
one 201, two 409, exactly one `AgentRun` row, lock row gone the moment the run ended.

**A worker is a process on the HOST, and the runner is the only thing that may start one (BEA-1389,
agent workers 4/10 — `specs/AGENT-WORKERS.md` §F).** `services/host/worker-runner.server.js` +
`services/host/mybrain-worker-runner.service`, a sibling of `codex-runner` with the same
versioned-copy discipline (repo copy is the truth, live copy at `/home/sandy/worker-runner/server.js`,
install written down in `services/host/README.md`). It lives outside the container because the app
image has no `child_process` usage at all and a second container must not write the same SQLite file.
**The port is 8769, not the design's proposed 8766** — 8766 is still held by the retired gws-runner,
and 8765/8767/8768/8770 are the codex/gemini/claude/agent-helper runners (`ss -ltnp`, 2026-08-22);
`WORKER_RUNNER_PORT` here and `WORKER_RUNNER_URL` in `deploy.sh` override it on both sides.
`POST /run {jobId, runId, token, seed?, kit?, timeoutMs?}` spawns `node --max-old-space-size=512
worker.mjs` in `<root>/<jobId>/current`, **detached** so a timeout `SIGKILL`s the whole group, and
answers **ndjson**: `{type:'step', step}` for every JSON line the worker prints, `{type:'log', line}`
for anything else, and a final `{type:'result', status, rows, error}`. The steps the owner reads do
NOT come down this stream — `kit.step()` posts them to `/api/worker/step` — this stream is the
runner's own play-by-play and its verdict. **Nothing dangerous comes from the request**: `NODE_OPTIONS`
is emptied by the runner, argv/heap/cwd are fixed, there is no shell, and the child does **not**
inherit the host environment — the run token is the only secret it ever sees, minted per spawn by
`WorkerTokenService`, never written into the worker folder. A malformed request is a plain 400; a
request that is fine but cannot run (no worker installed, kit too new, job already running here) is a
200 ndjson stream whose ONE line is the honest failed result, so the app has one road to parse.
**Kit refusal is the rollback guard**: `deploy.sh` re-tags `mybrain-app:prev` and never touches
`/srv/mybrain-workers`, so a rolled-back app can meet a newer worker — a `meta.kit` major above the
app's kit is refused BEFORE the spawn with `kitRefused:true` and a plain sentence (also in DEPLOY.md).
`POST /build {jobId, brief}` is the plumbing piece 5 drives (new `vN`, pin the kit, `BRIEF.md`, one
fresh `codex exec -s workspace-write -C vN`, then `node --test worker.test.mjs` parsed from TAP) and
it deliberately does **not** promote — moving `current` is the build turn's decision. `GET /status`
answers the codex runner's keys (`installed/version/loggedIn/ready/workdir/runner/engine`) so the
engine pill works unchanged; Codex being logged in is reported but does not decide `ready`, because
only `/build` needs it. It NEVER opens the database. Trust entries under the workers root are pruned
from `~/.codex/config.toml` at boot and after every build. Proof: `api/src/worker/worker-runner.spec.ts`
runs the real file as its own process against the real controller + real tokens over a real listener
(streaming, timeout kill, kit refusal, the child's own environment, traversal, one-run-per-job), and
it was driven by hand on the VPS on 172.18.0.1:8769 with `curl -N` before shipping. Traps: watch
**`res`** for the client going away, not `req` — a fully-read request stream closes the moment its
body is consumed, so a `req.on('close')` kill would kill every worker the instant it started; the
result line the runner writes is built field by field, so a new field (like `kitRefused`) has to be
added there too or it is silently dropped; steps, logs and stderr share ONE 2,000-line relay budget
(a flood of JSON is exactly as expensive as a flood of text) and an oversized body needs
`req.destroy()` after its 413, or the paused socket strands the connection (BEA-838, again). There is
an off-by-default shared secret (`WORKER_RUNNER_TOKEN` + `x-runner-token`) for the day piece 5 sends
real briefs to `/build` — that is the one route that runs a Codex session on a caller's text.

**The build turn: Codex compiles an approved plan into a tested worker (BEA-1390, agent workers 5/10
— `specs/AGENT-WORKERS.md` §C, §D).** `WorkerBuildService` (`api/src/worker/worker-build.service.ts`)
is the whole turn on the app's side: the job's plan (`planFromAgent`) → a build brief (the plan in
the owner's own terms, the pinned `kit/kit.js` + `kit/KIT.md`, the **fact card** for every action it
calls, and the saved `ToolSample`s its tests will stand on) → `WorkerRunnerClient.build()` → the
runner makes `vN`, writes those files, runs **ONE fresh `codex exec -s workspace-write -C vN`**
(`resume` cannot change sandbox or cwd, so a build can never be a resumed session) and then `node
--test worker.test.mjs`. **Green tests are the only thing that moves `current`**: promotion is
`POST /promote` on the runner (an atomic symlink move; the same call with an older version is the
rollback), and it happens after the tests, never before. A build that writes nothing, writes no
tests, fails them, or passes and cannot be put live leaves the job **on the road it was already on**
— the plan runner, or its previous worker version — and the `WorkerBuild` row says which, in words.
**The newest `promoted` row IS the live worker** (no "current version" column anywhere else), and
`planHash` on it is what makes a worker **stale**: `planHashOf()` hashes what the worker DOES (sources
· args · pages · merge · shape prompt · watch · output · notify), so a rename does not, but a changed
hashtag or output does; the job's plan is hashed fresh on every read, so staleness is a comparison,
never a flag. Routes: `GET /api/agent/agents/:id/worker` (version, tests, stale, the last 10 builds)
and `POST …/worker/build` (Create/Rebuild). **A promoted worker is installed and inert** — nothing
dispatches a run onto the worker road yet, so every live agent keeps running exactly as today; the
Worker tab that taps these routes is piece 9, `contract.json` is piece 6. The kit is read off disk at
run time, so the Dockerfile copies `src/worker/kit` into `dist/worker/kit` (`tsc` does not carry
non-TS files). Only the newest promoted build's samples are pinned against the eviction sweep
(`ToolSampleService.setPinned`, `pick()` returns the row id beside the answer). Traps: the runner's
`WORKER_API` default `127.0.0.1:3000` answers nothing on this VPS — the app container publishes **no**
host port, so the unit sets `https://mybrain.1site.ai`; `codex exec --json` announces its id as
`thread.started`/`thread_id`, not `session_id`; a build's `files` map is checked for `..`/absolute
paths BEFORE the version folder is made, so a bad request leaves nothing behind.

**A worker knows what "it worked" means, and fails loudly (BEA-1391, agent workers 6/10 —
`specs/AGENT-WORKERS.md` §E).** BEA-1377 fetched 90 answers, recognised 0 rows, wrote an empty
Google Sheet, reported success and cost 101 credits. Now every worker folder carries
**`contract.json`** — `minRows · maxRows · columns · mustHave · freshnessDays · allowEmptyWhen` —
**written by the app, not by Codex**: `contractFromPlan()` (`api/src/worker/contract.ts`) derives it
from the same plan the worker is compiled from, the build turn ships it as a file, and the brief
tells Codex to use it and never edit it (a contract a model invents can be as wrong as the bug it is
meant to catch). It only asserts what can be KNOWN: `columns` only when the task names them in so
many words (`columnsNamedIn`), `mustHave` only a link-shaped column of those, `freshnessDays` only
from a creators block's own `keepDays` — a check that fails a good run would teach the owner to
ignore the alarm. **`kit.expect(rows, contract)`** runs before the output step (pure, local, free, no
place in the call order, so a replay reaches the same verdict) and throws `ContractError` with a
sentence the owner reads on the run screen; the kit **refuses `writeSheet`/`writeDocument` when a
contract exists and `expect` was never called**, so a forgotten check cannot reopen the hole. **The
boundary is the whole piece**: `empty:true` alone cannot tell "the vendor had nothing" from "we could
not read what it sent", so the BEA-1377 tripwire's verdict now rides as **`unrecognised`** on
`FetchOut` → `POST /api/worker/tool` → the kit's own memory of every fetch (never the worker's story
about it). Genuinely empty → the run finishes `done` with 0 rows and writes nothing, exactly as
`nothingFound()` always did; unrecognised → the run FAILS and writes nothing. **The plan runner is
untouched** — the owner's live jobs behave exactly as before; the contract is the worker road's. The
owner reads it in the job's Settings: the **"What counts as a good run"** accordion row
(`contractWords` off `GET /api/social/plan/:agentId`, direct-fetch jobs only — the full Worker tab is
piece 9). Proved by `kit-contract.spec.ts` (the real controller + real saved answers: a creators job
whose per-creator payloads arrive as a JSON string fails with "fetched 3 answers but recognised 0
rows", no sheet, no document, no WhatsApp) and by a real Codex build turn whose own tests cover both
cases.

**A broken worker repairs itself, and it may not change the answer to do it (BEA-1393, agent
workers 8/10 — `specs/AGENT-WORKERS.md` §G).** The owner's reason for this architecture: *"If a
micro-service fails, Codex will re-stitch the changes that are required."* `WorkerRepairService`
(`api/src/worker/worker-repair.service.ts`) is that mechanism. A failed worker run is caught at
**`AgentService.finishRun()`** through the new `setRunFailedHook()` — the one door every terminal
state comes through (the worker's own `/finish`, the sweeper's 12-hour deadline, the stall watchdog)
— and it runs BEFORE the controller drops the run's journal, so the answers that broke it are still
there: each is kept as `ToolSample(kind:'failing')` with the error, the rule and the contract in the
payload (`keepFailing()`; `mayKeepFailing()` keeps the privacy half of `shouldSample` to the letter
and drops the allow-list, because evidence is worth keeping wherever it came from — but nobody's
messages are). **Two attempts, the owner's number, counted per CAUSE** — `jobId|rule|actionId`
(`causeOf` in `worker/repair.ts`), where the rule is read out of the failure's own sentence and
`repair.spec.ts` drives the REAL `checkContract()` to produce every one of them, so the two cannot
drift; the same cause never re-enters the loop once stopped, a different one still may (a crash
carries a signature of its message). `onRunFailed` only captures and queues; `tick()` (a minute)
claims the **BEA-1388 job lock** and drains, so a repair never runs while a run of that job is in
flight — `RunLockService.renew()` is new, because two Codex turns outlast the 30-minute expiry. A
repair turn is `POST /build` with the new **`copyFrom`** (the runner copies the version that broke,
never its `meta.json`) plus `samples/failing.json`, the contract it may not edit, and what the last
attempt already tried. **The promotion guard is the rule that keeps this trustworthy**: green tests
are not enough, so the live version and the repair are BOTH run against the same saved answers by
`POST /parity` — the app writes that harness (`parity-harness.ts`), never Codex, it runs in a
throwaway copy of the folder with no token, no API address and `fetch` replaced by a throw, and
`driftOf` holds anything past `PARITY_TOLERANCE` (a tenth of the rows; a column change is never
inside it; order alone is not a change; unmeasurable is held, never promoted). A held repair waits
for the owner (`POST /api/agent/agents/:id/worker/repairs/:buildId/accept|decline`; the buttons are
piece 9's). After two failures the job is paused the one existing way — `enabled:false` AND
`pausedReason` (`SocialBudgetService.pauseAgent`'s convention) — and `AlertsService.workerRepair()`
tells him what broke and what was tried, offering "run it the old way"; **nothing here retires a
job** — that switch is BEA-1394's. Proved for real on 2026-08-22: real Codex built v1, the saved
answer's `url` was renamed `permalink_url` (a field moving, the BEA-1377 shape), v1 failed loudly
("Only 0 of 3 rows have a link…"), a real Codex repair wrote v2 that reads both names, 8 tests
green, promoted — **0 vendor calls**. Named limitation: a job whose columns come out of the AI
shaping step has no parity baseline (the ruler does not run a model), so the guard falls back to
"nothing to preserve" for those. Traps: the cap's counter and the "what was already tried" note must
read the **same** build statuses (`failed|held|promoted` — `COUNTED`); two lists gave one cause three
Codex turns in review, and a `held` repair also blocks a new one until the owner decides. The
journal records a call's position and its answer, never its arguments, so the evidence's `args` come
off the job's own plan (`argsOf`).

**The switch that makes any of it run, and the tidying up after it (BEA-1394, agent workers 9/10 —
`specs/AGENT-WORKERS.md` §I, §J).** Every piece above assumed something else decided WHEN a job runs
on its worker: nothing did, so a promoted worker had been installed and INERT since BEA-1390.
**`Agent.useWorker` (default false)** is that switch and `WorkerDispatchService`
(`api/src/worker/worker-dispatch.service.ts`) is the decision — taken at **`HermesBridgeService.
startRun()`**, one line after the per-job lock is claimed, because that is the one door the
scheduler, both manual routes, event triggers and the voice lane already come through (it registers
itself there through `setWorkerDispatch()`; WorkerModule imports HermesModule and nothing imports
back, the `setFlowSync` seam again). A run takes the worker road **only** when the job has a promoted
worker AND the switch is on — **nothing converts automatically, ever**, and "run it the old way"
turns it off instantly with no rebuild. **The worker road being unavailable is never a failed run**:
stale (the plan was edited since the build), missing, or refused by the runner (kit too new, runner
down, host busy) → the plan runner takes that run and the reason is an `info` step the owner reads.
The fallback is decided on two facts and never on the error text — the runner's new **`notStarted`**
(a refusal BEFORE any spawn; added to the result line in `worker-runner.server.js` AND parsed in
`worker-runner.client.ts`, or it is silently dropped) AND an empty `RunJournal`, because a client
timeout on a worker that really was working also answers `notStarted` and the journal is what stops
that from fetching, writing and messaging twice. **Deleting an agent now leaves nothing behind**:
`deleteAgent` sweeps `RunJournal` (BEFORE the runs, or there is nothing left to find its rows by),
open waitpoints, the lock, `WorkerBuild`, the job's `ToolSample`s, and the host folders through the
runner's new `POST /remove` (best effort — a runner that is down must never leave a job that cannot
be deleted); `ToolCall` rows STAY on purpose, because that table is the credit ledger the daily
Social ceiling is summed from. **Cost is per run at last**: credits summed from the run's own
`ToolCall` rows, AI tokens added onto the new `AgentRun.aiTokens` by both roads (`UsageLog` is keyed
by feature and has no run on it), shown on the run screen and in the Worker row. **The Worker row**
(`web/src/pages/AgentWorkerRow.tsx`, in the BEA-1381 accordion, direct-fetch jobs only) shows the
version and when it was built, its tests, the switch, what the NEXT run will really do **in the
server's own words** (`decideFor()` — the same function that dispatches, so the two cannot disagree),
the contract in plain words (BEA-1391's lines, reused not re-derived), staleness with Rebuild, the
repair history and the held-repair buttons. Proved end to end on a throwaway job with **0 vendor
calls**: OFF → the plan runner; ON → a real worker process on the host, its steps on the run screen,
`runKind:'worker'`, done; plan edited → "the plan changed since worker v1 was built" and the old way;
runner stopped → said so and went the old way instead of failing; deleted → no rows, no folder.

**The worker road, honestly, as it stands after the acceptance run (BEA-1395).** All ten pieces are
built and proved on the owner's own job ("Smart Home Instagram Profiles", `743d0852…`) on the live
system for **3 credits**: a worker compiled from his live plan gives the plan runner's rows cell for
cell on the same saved answers; a broken saved answer makes it fail loudly, keeps the evidence, and
the app repairs and re-promotes itself with **zero vendor calls**; a question really reaches his phone
and the answer resumes the run from where it stopped, repeating no fetch, no write and no message.
Three things a fresh session must know: **(1) it is OFF everywhere.** `Agent.useWorker` is false on
every job, including his; nothing converts automatically and turning it on is his tap in the Worker
row. **(2) The runner is not installed as a service.** `services/host/worker-runner.server.js` needs a
systemd unit and that needs root; until then it is started by hand
(`WORKER_API=https://mybrain.1site.ai WORKER_ROOT=/home/sandy/worker-root
WORKER_RUNNER_TOKEN=<the shared secret> node …/worker-runner.server.js`,
port 8769) and dies with the box — and while it is down every run simply goes the old way and says so,
which is what the BEA-1394 fallback is for. **(3) A worker only repairs what is IN the worker.** The
acceptance break (a vendor answer the row reader could not read) was repaired with a new test and no
code change, because the reading lives in the app — `tableOf`/`itemsOf` — not in the worker. Do not
expect self-heal to fix an app-side shape bug.

**The re-verification's seven fixes (BEA-1401).** Two independent passes found no critical bug; these
were the real gaps, and they are closed. **The runner's door is locked and its `ready` is a promise**:
`WORKER_RUNNER_TOKEN` is now REQUIRED — `/run`, `/build`, `/promote`, `/parity`, `/remove` answer 401
without it and a runner started without one refuses everything and says so (`deploy.sh` carries the
app's copy from `.claude/checks/secrets.env`; the host's is `/home/sandy/worker-runner/runner.env`,
read by the unit, never in git) — and `WORKER_ROOT` is PROVED on every `/status` (created where it
can be, then written to), so an unusable root is `ready:false` + a plain `reason` + a refusal on
every route, never the old `ready:true, workers:0` that made a promoted worker invisible and killed
the first build on EACCES. **A build's tests run where `/parity` runs**: `childEnv()` (none of the
host's environment) and `node --import <preload> --test`, the preload throwing on `fetch`/`net`/`tls`/
`http`/`https`/`dns`; the Codex turn itself stays networked ON PURPOSE and the README says so. **A
worker may only call its own job's actions** — the `{actionId,args}` road is checked against
`planActionIds` ∪ `Agent.tools` (§C says there is no exception; add it to the job instead). **A
worker run's journal is dropped inside `AgentService.finishRun()`** (registered by
`WorkerDispatchService`, after the failure hook that reads it), so the stall watchdog, a deadline with
no default and an overtaken run stop leaking whole fetched tables. **`deleteAgent` also sweeps the
run-scoped `ServiceGate` rows** (a permanent /tools release is left alone). **Failing evidence has a
wider deny list** (`NO_FAILING_SERVICES`: calendar, drive, notes, contacts, photos, meetings) on top
of `NO_SAMPLE_SERVICES`. And the owner has **NINE** agents, not six — all enabled, all `useWorker:false`.

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

