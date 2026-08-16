# My Brain — Tools (external services for agents) — what we're building (and why)

**Composio becomes the default tool layer for anything outside My Brain.** 1,209 services (GitHub, Slack, Linear, Notion, Jira, Stripe, Google…) reachable by an agent, with logins the owner clicks once, action schemas the agent can discover, and events that can wake a flow. Our own code stays only where nobody else can reach.

## Why
Agents can't do a developer's work without the developer's tools. Today the catalog is **20 hand-written tool ids** plus 11 read-only Google entries. A single Composio toolkit carries hundreds.

**Verified against the live API** (`GET /api/v3/toolkits/<slug>` with our key, 2026-08-16) — **1,209 toolkits total**:

| Toolkit | Tools | Triggers | Composio-managed auth |
|---|---:|---:|---|
| GitHub | 871 | 46 | yes |
| Stripe | 425 | 7 | yes |
| Sentry | 209 | 0 | yes |
| Slack | 158 | 9 | yes |
| Vercel | 131 | 0 | **no — needs our own OAuth app** |
| Jira | 97 | 3 | yes |
| Google Drive | 77 | 7 | yes |
| Gmail | 61 | 2 | yes |
| Notion | 53 | 8 | yes |
| Linear | 46 | 12 | yes |
| Google Calendar | 45 | 7 | yes |

> Composio's docs pages and marketing pages both disagree with the API and with each other (docs said GitHub 893/20, the site said 846/46; the API says **871/46**). **The API is the only source of truth — read counts from `listActions()` at run time and never hard-code one.** Note also that not every toolkit ships Composio-managed auth: Vercel needs our own OAuth credentials, so `connect()` must handle that case rather than assume a one-click flow.

The gap isn't access — `google.service.ts` already has a generic `run(argv)` passthrough that reaches the whole Google API. The gap is **schemas**. Every capability we own cost a hand-written wrapper, and an agent can't call `run()` blind. Composio's product is 1,209 services an agent can find and call **without us writing a wrapper each time**.

It is also the only path to SaaS. The gws bridge is a CLI on our VPS logged in as one account (sandy@kiot.io). It cannot read a customer's mail, and it cannot hold a second inbox. Composio can do both (`allowMultiple: true`, `connectedAccountId` per call).

## Decided
- **Composio is the default for third-party services.** Ours stays only for: the Brain (search/fetch/remember), Output (save document/capture/task), the News pipeline, Skills, `http`/`cli`, **WhatsApp** (a real Pinnacle BSP number — not replaceable), **Telegram** (our own bot + alerts), **Deepgram/ElevenLabs** (live audio streaming), and **web research**.
- **Web research stays ours, on evidence.** Composio's Exa toolkit *requires your own Exa API key anyway* — it would be our key, their hop, and a billed call, while handing back the search control taken deliberately in BEA-1194. `deep-research.service.ts` (568 lines of budgets, date windows, dedupe and spend accounting) has no equivalent.
- **AI engines untouched.** OpenRouter, OpenAI, Anthropic, Gemini stay exactly as they are. They are engines, not tools.
- **Google moves to Composio, in stages.** Build beside the gws bridge; keep the Daily Brief and Requests running on gws until the Composio versions are proven live on the same inbox; retire the bridge in a follow-up issue. Never delete a live feature on day one.
- **One Composio API key per instance**, stored in the existing `Connector` table (AES-256-GCM), set in Settings. Ours holds ours; a customer's instance holds theirs. `user_id` = our user id. That is the whole tenancy story — no control-plane work, and no third-party tokens of ours in anyone else's database.
- **Full access with gates.** No allow-lists and no read-only mode: a connected service exposes everything. Actions that **can't be undone** stop and ask first.
- **Ids never say "composio".** Every id is `svc:<service>.<action>` (`svc:github.create_issue`); the provider maps it to `GITHUB_CREATE_ISSUE`. Tool ids are dispatched on by `flows-runner.service.ts` and saved inside flows — a vendor name in an id would make the provider unswappable.

## Architecture
`ServiceProvider` — one interface under the existing single catalog (BEA-1167):
`listServices() · listActions(service) · connect(service,user) · disconnect() · execute(action,args,user) · status()`

`ComposioProvider` is the first implementation. `ToolCatalogService.catalog()` gains one line beside `googleTools()`/`mcpTools()` and one new group, **Services**. Nothing above the catalog — picker, canvas, splitter, saved flows — knows Composio exists.

**Execution path (no engine turn).** Sonnet 5 splitter picks the **service** for a branch → Composio session search finds the **action** → one small Sonnet 5 call fills the arguments from the action's JSON schema → `directTool()` runs it → Codex only writes up the result. Per BEA-1203: deciding what to do next earns an engine turn (~118,000 tokens); calling an API does not.

**Never load 1,209 toolkits into a prompt.** Sessions are scoped to the services actually connected (`toolkits: ["github","slack"]`) and discovery uses Composio's own search.

**Built (BEA-1347), with one correction to the path above.** There is no discovery step at run time
and no session search: the splitter picks a whole `svc:<service>.<action>` id straight out of the one
catalog, so by the time a step runs the action is already named. Its schema is then fetched
*exactly* (`GET /tools/<SLUG>`), because the list endpoint's `search` is not semantic — asked for
`GITHUB_GET_THE_AUTHENTICATED_USER` it returns `GITHUB_CREATE_OR_UPDATE_A_SECRET_…` first, and a
step that found its own action by searching would run the wrong one and call it done. That leaves
exactly ONE model call in the path — `service-args`, capped, filling the arguments from that schema
— and none at all when the action takes no arguments or the owner pinned them on the step.

`api/src/tools/service-actions.service.ts` owns it, and **every road but a real success throws**: an
`svc:` id is not in `AGENT_TOOLS`, so anything that returned instead would fall through to a plain
model call and hand back an invented result.

## Gates
Rules first, overrides second — 1,209 services cannot be hand-tagged. Gated when the action slug matches: `DELETE_ · REMOVE_ · MERGE_ · ARCHIVE_ · REVOKE_ · TRANSFER_ · REFUND_ · CANCEL_ · BLOCK_ · INVITE_ · *_COLLABORATOR · *_ROLE · *_PERMISSIONS`, plus a small hand-kept list. Everything else runs free.

A gate uses the **durable Ask-me** already built for agent runs (BEA-795) — the run pauses and survives a restart rather than timing out. Chat confirms inline. Any gated action can be released permanently from `/tools`.

**Built (BEA-1348).** The failure that mattered was over-gating: the owner accepted full access on the
understanding that he sees a gate "maybe once a week, so I'll actually read it". So `isRiskyAction()`
in `service-provider.ts` — the ONE place that decides what is gated, extended rather than duplicated —
now reads in five steps: a **read is never gated** (`GET/LIST/SEARCH/CHECK/VERIFY…`, which is what
saves `LIST_REPOSITORY_COLLABORATORS`); then a hand-kept **must-gate** list for what the rules miss
(`RESET_A_TOKEN`, `CONFIRM_PAYMENT`, `CAPTURE_PAYMENT`, `PAYOUT`); then a hand-kept **allow** list for
detach-and-re-attach false positives (remove a *label*, *assignee*, *reviewer*, *reaction*, *star*);
then the spec's prefixes, plus the same words anywhere in the name (`FORCE_CANCEL_…`,
`SLACK_DELETES_A_MESSAGE…`); and last `COLLABORATOR · ROLE · PERMISSIONS` anywhere, but only when the
action is not a read. Audited against the live API on 2026-08-16: **2 of the 36 GitHub actions the
catalog actually offers** are gated (`ADD_A_REPOSITORY_COLLABORATOR`, `DELETE_A_REPOSITORY`) — 120 of
all 823, Slack 17/133, Linear 1/21, Notion 2/28, Gmail 2/23, Stripe 4/33 — and every one of them reads
as genuinely irreversible.

The gate fires in `ServiceActionsService.run()` **after the arguments are filled and before
`provider.execute()`** — the only point where the action, the account and the final arguments are all
known at once. It writes its `ToolCall` row (`gated: true`) BEFORE pausing, so a run killed mid-pause
still shows the attempt, and then **throws** `GatePause` — never returns, because a returned string
falls through to `askModel()` and invents a result. `flows-runner` turns that throw into the same
durable pause an "Ask me" block uses: the run row goes `waiting` with the question and two buttons
(Yes, run it · No, stop), and the step's own result carries the exact arguments the owner was shown,
so the pending gate survives a restart. Saying yes writes a one-time `ServiceGate` row and re-runs the
step with **those** arguments — never a fresh model guess, or he would approve deleting one branch and
watch another go. Saying no fails the step with a sentence that says why, and it can never be re-asked
(`gateRejected`). Anything that is not plainly a yes is a no. A single-step "run to here" has no run
row to pause on, so a gated action there stops and says where the question can be answered. Released
permanently = a `ServiceGate` row with `scope: 'always'`, managed per service in `/tools`.

**Built in Chat too (BEA-1349), and inline.** Chat gets the same `svc:*` entries the agents get,
scoped to what is connected, and the gate becomes a card in the thread with two buttons instead of a
durable waitpoint — the owner is sitting right there, so there is nothing to survive a restart for.
Same `ServiceGatesService`, same `ServiceGate` row, same approved arguments re-run; only the waiting
is different. Every chat call writes its `ToolCall` row with `runKind: 'chat'`, keyed on the session
and the **user message id**, which is what makes a yes spendable exactly once.

Two rules the chat side adds:
- **Nothing connected ⇒ nothing changes.** `ChatToolsService` asks the catalog first and returns
  before any prompt is built or any model is called. Chat is the screen the owner is on all day, and
  a feature he has not set up may not cost him a millisecond or a new failure mode.
- **A failure is never written up by a model.** A gate and a refusal both skip the answer call
  entirely: the reply IS the service's own sentence ("GitHub could not do that: Not Found (404)").
  Handing that to a model to phrase nicely is exactly how a refusal becomes a polite apology.

Picking is two small calls, not one big one: the first is shown only the connected service *names*
(a couple of hundred tokens, and it answers "none" nearly every time), the second — only once he
really is asking for something to be done — is shown that one service's actions. Neither is ever
allowed to name something outside his own catalog.

## Triggers
Events from a connected service that start a flow. Real counts from the API: GitHub 46, Linear 12, Slack 9, Notion 8, Google Calendar 7, Drive 7, Gmail 2 — and **zero for Sentry and Vercel**, so the UI must handle a connected service that has no triggers at all. Enumerate per service; never assume. Realtime push for Slack/GitHub/Notion; ~15-minute polling for Gmail/Calendar. 50,000 events/month free. This is the missing **live** half of Flows Stage 3, which today only has the schedule half.

Two guards, both required:
- **Echo guard** — every inbound event is checked against the `ToolCall` log; if we caused it, it is dropped. Without this: agent posts to Slack → trigger fires → flow posts again → forever.
- **Rate cap** — per binding (default 20 runs/hour); on breach the binding pauses itself and tells the owner.

**Built (BEA-1350).** `api/src/triggers/` — its own module, and that is forced rather than chosen:
`FlowsModule` already imports `ToolCatalogModule`, so a triggers service inside the tool catalog
would be a cycle. Events arrive at ONE public route, `POST /api/tools/triggers/events/<secret>`,
whose last path segment is the secret (the shape the document ingest endpoint has used since
BEA-535) — compared in constant time, and answered **202 before the work starts**, because a
provider kept waiting retries and a retry is a duplicate run. The address is registered with the
provider by us (`POST /webhook_subscriptions`, one per account) and is **masked everywhere it is
shown**: printing it on a screen is printing the secret.

The counts are read per service at run time and a service may have **none** (Sentry and Vercel have
zero), which the UI says in a sentence instead of drawing an empty picker. The provider also says
per event whether it is pushed or polled (`webhook` 108 · `poll` 254 of 362 live types) and a polled
one carries its own interval, so "as it happens" versus "checked every 2 minutes" is read, never
guessed — and it is on every row of the picker, because they are different promises.

**The guards are the point of the issue**, because the owner chose no confirmation on normal writes:
- **Echo** (`triggers/echo-guard.ts`) — a read is never blamed; then identity (something our call was
  handed back appears inside the event — the precise rule); then subject (the event and a recent call
  of ours are about the same *thing*). It must **never filter on `runKind`**: Chat writes to the same
  log now (BEA-1349), and a message the owner sent from Chat echoes back exactly like an agent's.
  The window is built from the event's own interval (5–30 minutes) and every drop is written down
  with the `ToolCall` it blamed, because a loose rule that drops silently is a rule nobody can trust.
- **Rate cap** — 20 runs an hour by default, counted over a rolling hour from the binding's own
  history. On breach the binding **pauses itself, removes its subscription, records why and pushes a
  Telegram message** — nobody is watching a background rule, so a screen would not do.

`TriggerBinding.triggerInstanceId` is removed at the provider whenever a rule is switched off,
paused or thrown away, and the row is only written after the subscription exists — an orphan
subscription bills the owner for a rule he thinks is gone. A trigger-started run uses the **durable**
pause (BEA-795/1348), never Chat's inline card, and a flow that fails leaves the rule ON with the
failure in its history.

## Data
| Where | What |
|---|---|
| `Connector` (exists) | `composio` → `{ apiKey }`, encrypted. No new table for the key. |
| `ServiceConnection` (new) | service · connectedAccountId · label · status · connectedAt · lastUsedAt. Several rows per service = several accounts. |
| `ToolCall` (new) | agent/run · service · action · arguments · result · ok/failed · ms · gated. The flight recorder — and the echo guard's source of truth. |
| `ServiceGate` (new) | service · action · scope (`once`/`always`) · run/step · decision · the approved arguments · question. One row per gate answered, and one per action released for good. |
| `TriggerBinding` (new) | service · triggerType · triggerInstanceId · flowId/agentId · enabled · rate cap · lastFiredAt · pausedReason |
| `Agent.allowedTools` (exists) | `svc:*` ids drop straight in. No change. |

## UI
**`/tools`**, next to Skills in the nav. No hand-curated shortlist — browse Composio's own categories (Developer Tools, Communication, Productivity, CRM…) with search across all 1,209 over the top, so the page is never blank on first visit. A card per service: connected accounts, action count, last used, gated actions, Connect / Disconnect / Manage. Add a second account of the same service from the same card.

They then appear with no extra work in the **agent Tools box** (`ToolPicker`), the **Flows canvas** (draggable nodes) and **Chat** (inline confirm + tool chips in the reply).

## Build order (one batch)
1. **Seam + provider** — `ServiceProvider`, `svc:*` ids, key in Settings, catalog merge, blocked services (`exa · firecrawl · tavily · perplexity · telegram · whatsapp`)
2. **`/tools` page** — categories + search all, connect/disconnect, multiple accounts, manage
3. **Execution** — `directTool()` branch, argument filling, `ToolCall` flight recorder
4. **Gates** — rules, durable Ask-me pause, release permanently
5. **Chat can act** — inline confirm, tool chips
6. **Triggers** — webhook endpoint, per-service instances, wake-a-flow bindings, echo guard + rate cap
7. **Retire gws** (follow-up, only once 1–6 are live and proven) — move the Daily Brief, Requests, email memory and Drive import onto Composio, then switch the bridge off

## Standards (always)
List standards on `/tools` (search · filter · sort · count · loading · empty state). Responsive at 1180 and 390 · dark mode · confirm before disconnect · friendly errors when a connection expires · the Composio API key never in code, logs or git · every tool call logged.

## Out of scope (for now)
EMO voice acting on tools (no confirm step in a voice path) · Composio's sandbox/workbench · custom Composio tools · white-label OAuth apps (each instance uses its own Composio account, so branding is that account's concern) · retiring the gws bridge before 1–6 are proven live.

## Known risks (accepted)
- **Composio was breached on 21 May 2026** — ~5,241 API keys and 5,001 GitHub OAuth tokens taken via an employee's Gmail token; all customer GitHub tokens were revoked. Accepted knowingly: each instance holds its own Composio account, so blast radius is one owner, not all owners.
- **Two Google grants during the migration** — the same mailbox authorised to both gws and Composio until step 7 retires the bridge.
- **Latency** — a Composio call is a network hop to them and then to the provider; slower than the local gws bridge. Irrelevant for background runs, mild in Chat.
- **Cost** — everything we run today is ~6,000 tool calls/month against a 100,000 free tier. Cost is not a constraint at this size; overage is $0.0003/call.
