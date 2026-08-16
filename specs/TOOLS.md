# My Brain — Tools (external services for agents) — what we're building (and why)

**Composio becomes the default tool layer for anything outside My Brain.** 1,119 services (GitHub, Slack, Linear, Notion, Jira, Stripe, Google…) reachable by an agent, with logins the owner clicks once, action schemas the agent can discover, and events that can wake a flow. Our own code stays only where nobody else can reach.

## Why
Agents can't do a developer's work without the developer's tools. Today the catalog is **20 hand-written tool ids** plus 11 read-only Google entries. A single Composio toolkit carries **hundreds** — GitHub alone is in the 800s.

> **On the numbers.** Composio's own two sources disagree, so treat every per-toolkit count below as approximate: GitHub 846–893, Slack 145–167, Gmail 61–63, Linear 32–47. Triggers disagree more (GitHub 20 vs 46, Linear 3 vs 12). The **1,119 toolkits** total is solid — stated twice on their directory ("Showing 1–30 of 1119"). **Read real counts from `listActions()` at build time; never hard-code a number from a web page.**

The gap isn't access — `google.service.ts` already has a generic `run(argv)` passthrough that reaches the whole Google API. The gap is **schemas**. Every capability we own cost a hand-written wrapper, and an agent can't call `run()` blind. Composio's product is 1,119 services an agent can find and call **without us writing a wrapper each time**.

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

**Never load 1,119 toolkits into a prompt.** Sessions are scoped to the services actually connected (`toolkits: ["github","slack"]`) and discovery uses Composio's own search.

## Gates
Rules first, overrides second — 1,119 services cannot be hand-tagged. Gated when the action slug matches: `DELETE_ · REMOVE_ · MERGE_ · ARCHIVE_ · REVOKE_ · TRANSFER_ · REFUND_ · CANCEL_ · BLOCK_ · INVITE_ · *_COLLABORATOR · *_ROLE · *_PERMISSIONS`, plus a small hand-kept list. Everything else runs free.

A gate uses the **durable Ask-me** already built for agent runs (BEA-795) — the run pauses and survives a restart rather than timing out. Chat confirms inline. Any gated action can be released permanently from `/tools`.

## Triggers
Events from a connected service that start a flow. Every major service has them (GitHub, Slack, Linear, Notion, Gmail); the published counts are unreliable — see the note above — so enumerate them from the SDK. Realtime push for Slack/GitHub/Notion; ~15-minute polling for Gmail/Calendar. 50,000 events/month free. This is the missing **live** half of Flows Stage 3, which today only has the schedule half.

Two guards, both required:
- **Echo guard** — every inbound event is checked against the `ToolCall` log; if we caused it, it is dropped. Without this: agent posts to Slack → trigger fires → flow posts again → forever.
- **Rate cap** — per binding (default 20 runs/hour); on breach the binding pauses itself and tells the owner.

## Data
| Where | What |
|---|---|
| `Connector` (exists) | `composio` → `{ apiKey }`, encrypted. No new table for the key. |
| `ServiceConnection` (new) | service · connectedAccountId · label · status · connectedAt · lastUsedAt. Several rows per service = several accounts. |
| `ToolCall` (new) | agent/run · service · action · arguments · result · ok/failed · ms · gated. The flight recorder — and the echo guard's source of truth. |
| `TriggerBinding` (new) | service · triggerType · triggerInstanceId · flowId/agentId · enabled · rate cap · lastFiredAt · pausedReason |
| `Agent.allowedTools` (exists) | `svc:*` ids drop straight in. No change. |

## UI
**`/tools`**, next to Skills in the nav. No hand-curated shortlist — browse Composio's own categories (Developer Tools, Communication, Productivity, CRM…) with search across all 1,119 over the top, so the page is never blank on first visit. A card per service: connected accounts, action count, last used, gated actions, Connect / Disconnect / Manage. Add a second account of the same service from the same card.

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
