# My Brain — Social (social platforms as agent territory) — what we're building (and why)

**A new sidebar section, Social, where the owner points agents at social platforms.** Underneath it, ScrapeCreators becomes the **second `ServiceProvider`** beside Composio — **178 endpoints across 29 platforms, generated from their OpenAPI spec, nothing skipped** — and Social is the workspace built on top: browse a platform, run any endpoint right there, keep the result, turn it into an agent that fetches, digests, watches or alerts.

Tools (`/tools`) stays the place things get **connected**. Social is where social data gets **used**.

## Why
The owner's own example, and the whole point in one sentence: *"Get me all the Instagram posts related to Smart Home in India from the last 30 days, put them in a Google Sheet, send a copy to my WhatsApp — as an agent."* Three providers in one job (ScrapeCreators → Composio/Sheets → Postbox), on a schedule. **Three of the four legs were proven live on 2026-08-17** (`specs/SCRAPECREATORS-API.md`): 8 real Indian smart-home posts for 1 credit; a real Google Sheet created, filled and read back; the WhatsApp path exists and only awaits the owner's number in Settings.

The seam built in BEA-1345 was designed so a second provider slots in without the picker, canvas, splitter, Chat or saved flows knowing. **This is its first real test.**

## Decided
- **The OpenAPI spec is the source of truth.** `ScrapeCreatorsProvider` generates every action from `openapi.json` — name, description, parameters, response schema — and re-reads it on a timer. No hand-kept list. New endpoint on their side → appears here without a deploy. **A test asserts action count == spec op count. No cap, ever** (BEA-1354 lifts Composio's 60-per-service cap to the same standard).
- **Ids** are `svc:<platform>.<endpoint>` — `svc:instagram.search_hashtag`, `svc:youtube.video_transcript` — same shape as Composio's, and **the vendor's name never appears in an id.**
- **One API key per instance** (`SCRAPECREATORS_API_KEY` → `scrapecreators` connector, encrypted, Settings). No OAuth, no per-user login — simpler tenancy than Composio's, and one field per myemo customer.
- **No gates.** Every endpoint is a read. Social never asks a confirm.
- **Credits are first-class.** Every `ToolCall` records `credits_charged` from the response (never assumed — costs range 1 to 26). The Social header shows the balance and today's spend. A **daily credit ceiling** per instance pauses agents and tells the owner, exactly like the trigger rate cap.
- **Social is its own sidebar entry** under Automation (Agents · Flows · Skills · Tools · **Social**), not a category inside Tools.
- **The presentation follows ScrapeCreators' own grouping** — platform → their tags (profile · posts · comments · transcripts · search · ads) — in our house style with our components (`DataTable`, `Sheet`, `Skeleton`). Never a copy of their marketing page.
- **A Social agent is an ordinary Agent.** Same model, runs, history, grading, output destinations, Telegram/WhatsApp toggles. `Agent.tools` just holds `svc:` ids. Nothing forks.
- **"Write to a Google Sheet" becomes a first-class output destination** (`Agent.outputDest = 'sheet'`) alongside document / telegram / task, via Composio Sheets. It is what the owner's example wants and it costs almost nothing to add.
- **"In India" and similar are OUR filter step.** No social search has a country filter; the agent's AI step keeps the relevant ones after fetching. Recall over precision, and the spec says so plainly.

## Architecture
`ScrapeCreatorsProvider implements ServiceProvider` — `listServices()` = platforms from the spec's path prefixes; `listActions(platform)` = its ops with parameter + response schemas; `execute()` = one HTTPS GET/POST with `x-api-key`, returning `{ok, data, error, ms, credits}`; `status()` = balance. `connect()` = "paste your key" (a `needsCredentials` shape, already supported by `/tools`). It sits in `ToolCatalogService.catalog()` beside `ComposioProvider`; a new group **Social** in `GROUP_ORDER`.

Execution runs through the **same** `ServiceActionsService.run()` — direct, no engine turn, one capped `service-args` model call to fill parameters, every call logged. `ToolCall` gains a `credits` column.

**Watch/Alert** is the one genuinely new piece: `SocialWatch { agentId, actionId, args, lastHash, lastResult, lastAt }` and a diff routine that understands **lists** (new items since last time), **numbers** (crossed a threshold), and **text** (changed). An Alert is a Watch plus a plain-English condition evaluated by a small model call, then the existing push (Telegram/WhatsApp).

## The Social section — three screens
1. **Platform grid** — every platform from the spec, logo, endpoint count; header with credit balance + today's spend + the ceiling.
2. **Platform page** — every endpoint, grouped by the spec's tags, each with its parameters. **Run it right there**: a form generated from the parameter schema, result rendered below (transcript → text, list → `DataTable`, profile → card), cost shown. Cached calls show as 0.
3. **Result actions** — Save as Document · Send to Capture · **Make it an agent** (opens the normal agent builder pre-filled: tool, inputs, schedule, output destination).

## The four agent shapes
| Shape | Does | New? |
|---|---|---|
| **Fetch** | run on a schedule, save the result | no — all existing |
| **Digest** | several endpoints → AI shapes rows → Sheet/Document → WhatsApp/Telegram. **The owner's example.** | no — flow of steps + `outputDest:'sheet'` |
| **Watch** | run, diff against last time, save only what changed | yes — `SocialWatch` + diff |
| **Alert** | Watch + condition → push | yes — condition + existing push |

## Data
| Where | What |
|---|---|
| `Connector` (exists) | `scrapecreators` → `{ apiKey }` |
| `ToolCall` (exists) | + `credits Int?` — the honest cost per call |
| `SocialWatch` (new) | agentId · actionId · args (+ argsHash, the unique key) · lastHash · lastResult · lastAt · alertState · lastAlertedAt (BEA-1358) |
| `Agent` (exists) | + `mode` run/watch/alert · `alertCondition` · `threshold` JSON · `pausedReason` (BEA-1358) |
| `Setting` (exists) | `social.dailyCreditCeiling` (default 500, 0 = no limit). "Spent today" is NOT a Setting — it is the sum of `ToolCall.credits` since local midnight, one truth for the header and the ceiling check |
| `Agent.outputDest` (exists) | + `'sheet'` |

## The acceptance test for the whole batch — the owner's example, end to end
An agent, made from Social, that on a schedule: searches Instagram (`#smarthomeindia` + keyword, `last-month`) → merges + de-dupes → AI keeps India-relevant and extracts creator · followers · date · likes · views · paid-partnership · location · caption · link → **creates a Google Sheet and writes the rows** → **WhatsApps the owner the link**. Every step logged with credits. **Social is not done until this runs live, on the owner's real accounts, from a schedule.**

## Build order (one batch, 6 issues)
1. **Provider from spec** — generation, `svc:` ids, key in Settings, `credits` on `ToolCall`, balance, no-cap test
2. **Social section** — sidebar entry, platform grid, platform page, run-it-now, credit header
3. **Result actions + `outputDest:'sheet'`** — save / capture / make-agent handoff; Sheets as a destination
4. **Watch + Alert** — `SocialWatch`, diff, condition, push, daily ceiling
5. **The example, live** — the acceptance agent above, scheduled, proven on the owner's accounts
6. **BEA-1354** — lift the Composio cap

## Standards (always)
Every list through `DataTable` (search · filter · sort · count · pagination · loading · empty). Responsive at 1180 and 390, light and dark; a 178-endpoint platform page on a phone is the hard case. Key never in code/logs/git. Every call logged with its cost.

## Out of scope (for now)
Bookmarks-Instagram and AI Radar moving off Apify onto ScrapeCreators (cheap follow-ups, separate concern). Any write to any social platform (none exists here). EMO voice.

## Known risks (accepted)
- **This is scraping** of public social data without the platforms' consent; their terms don't love it. Fine for the owner's own research; a business question for myemo, not a build one.
- **Search caps at ~11 pages** per query — hundreds of posts per run, not thousands. Right for monthly digests.
- **Costs vary 1→26 credits** and are stated only in prose; the ceiling exists because a "comments on 50 posts" agent is 750 credits, not 50.
- **Country/region is our filter, not theirs** — recall over precision.
