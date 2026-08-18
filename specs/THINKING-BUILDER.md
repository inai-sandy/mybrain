# The thinking builder — an agent is designed by an AI that understands the ask, finds out what it needs, and plans the flow itself

**Status: DESIGN for review — nothing built. Owner asked for it on 2026-08-18 after the Social batch.**

## The problem, in the owner's words

> "While creating an agent the AI has to understand the requirement properly, question properly in the chat, and then build a proper flow by its own. Every requirement will be different — we can't use one interview technique for another. The AI has to collect as much information as possible."

What happened that made this obvious: "Get me all Instagram posts about smart home in India from the last 30 days" was turned into an agent by a **pre-filled form** (Social → Make it an agent). Nobody asked what "India" means for Instagram (there is no location filter), which sources to use, how many, or what "all" means. The agent copied one call and hoped. Result: 12 posts, none dated, one source empty because of a capital letter.

## What exists today (facts from the code)

- **Two chat builders** already exist: "New agent — just describe it" (`AgentAreasService.builderChat`, prompt `agent.builder`) and the per-agent job builder (`jobBuilderChat`, prompt `agent.jobBuilder`). Both keep the last 24 turns, hand the model a **shortlist of tools as one-line names** (`shortlistForPrompt`), and expect back `{reply, job}` JSON. Both run on **Codex** (`completeWithModel({provider:'codex'})`).
- They **cannot** see what a tool really returns (fields, dates, counts), its filters, page limits, cost, or whether it is broken right now. They **cannot** try a call. So their questions come from the model's general knowledge, not from facts.
- Social's "Make it an agent" **bypasses both** and opens a form (`NewAgentForm` pre-filled).
- What already works and stays: the direct Social runner (sources → merge → shape → Sheet/Document → WhatsApp/Telegram, Watch/Alert, ceiling), the plan → flow picture (BEA-1366), the run screen, grading, schedules.

## Principles (the owner's, made concrete)

1. **No fixed script.** The questions come from *this* requirement and from what the builder discovered — never from a per-case list we wrote. Two different requirements must produce different questions (a test asserts it).
2. **Facts before questions.** Before asking the owner anything, the builder reads what the tools can really do, and — when cheaper than asking — **looks for itself** with a small sample call.
3. **Ask only what is open**, one thing at a time, in plain words, always with the default it would take.
4. **Honest about limits.** If something cannot be done (Instagram has no location filter), it says so and proposes the nearest real thing — never a silent guess.
5. **Plan first, build on approval.** It shows the full plan with sources, sizes, schedule and an **estimated cost per run** (credits + AI tokens). Create only when the owner says so. The flow picture is drawn from that plan.
6. **Quality model for thinking.** Design work runs on Sonnet 5 through `completeHelper('agent-builder')` — never Codex for the interview (Codex only delivers), never a cheaper model (owner's rule). Every call capped; the whole design ≤ a set budget.

## The four pieces

### A. The know-how layer — what every tool can really do
A machine-readable card per action, built and refreshed automatically, that the builder reads instead of a one-liner:
- **From the vendor's spec** (already parsed for ScrapeCreators; Composio schemas already fetched exactly): parameters and their enums, response fields (does it return a date? likes? location? a cursor?), page/limit rules, cost hints.
- **From what actually happened** (`ToolCall` rows): fields seen in real answers, average items per page, real credits, and **health** — "answered `not_found` for every query in the last 24 h" (that is how the builder knows hashtag search is down today and plans around it).
- **From hand-kept notes** we already write for humans (`specs/SCRAPECREATORS-API.md`, `COMPOSIO-API.md` traps): moved into a small notes file the card reader loads (e.g. "popular search: no dates, 12 per page, lowercase keys, pages further with cursor"; "Instagram: no location filter anywhere; India = hashtags + creators + captions").
Stored as `ToolKnowledge { actionId, fields[], filters[], paging, cost, health, notes, updatedAt }`, exposed as `GET /api/tools/knowledge/:actionId` and handed to the builder for the shortlist it is considering — never the whole catalog.

### B. Look for yourself — the sample call
The builder may run **up to 3 sample calls per design, ≤ 5 credits total**, through the same `ServiceActionsService.runDetailed()` (recorded, `runKind:'builder'`, gates apply, reads only). It sees the real answer (shape + first rows) and plans from it: "Popular Search gave 12 posts, no dates → not usable for 'last 30 days'; hashtag search answered not_found → I'll add India creators instead." Every sample is shown in the chat as a line ("I tried X — got Y") so the owner sees the reasoning.

### C. Planning blocks the builder can use
The vocabulary the plan is written in — each block already runs, or is small to add:
- **Source** = one action + args + **pages** (new: 1..11, cost = pages) — the direct runner pages through `cursor`/`page` and de-dupes on the stable id.
- **Creators-first** (new): a profile/creator search → for each of the first N creators (cap 50) → that creator's recent posts → keep last X days. Volume + certain identity; cost ≈ 1 + N per run.
- **Merge + de-dupe**, **filter/shape** (Sonnet, named columns, keep rule), **Watch/Alert**, **Output** (Sheet new/append, Document), **Notify** (WhatsApp/Telegram), **Schedule**, **Ceiling** — all exist.
The plan is a JSON the runner executes and the flow-drawer draws (BEA-1366 already draws from these facts).

### D. The plan-with-cost screen, then Create
Before anything is created the owner sees: what it will fetch (sources × pages, creators), what it keeps, columns, where it goes, when it runs, who is told, and **≈ cost per run** ("≈ 90 credits · ≈ 60k AI tokens ≈ ₹18"). Buttons: Create · Change something (back to chat) · Not now. After Create: agent + flow picture + first "Run now" offered.

## The conversation, concretely (the owner's example, with today's facts)
> **Owner:** Get me all Instagram posts about smart home in India from the last 30 days, into a Google Sheet, WhatsApp me the link.
> **Builder:** (reads know-how: Instagram — no location filter; hashtag search returns dated posts, up to 11 pages, but has answered not_found for 18 h; reels search same; popular search: 12/page, no dates, healthy; profile search healthy) → tries one sample: profile search "smart home india" → 41 accounts.
> **Builder:** "Instagram can't filter by country, so 'India' will come from India hashtags, India creators and reading captions. Hashtag search is down at the vendor right now — I'll still include it so it fills in when it's back, and add the 41 India creators' recent posts so you get volume today. 'Last 30 days' means I leave out Popular Search (its posts have no dates). Is 'only dated posts from the last 30 days' right, or do you also want undated recent ones?"
> **Owner:** Only dated.
> **Builder:** "Then here's the plan: 6 India hashtags × up to 8 pages + posts from 41 creators, de-duped; Sonnet keeps India-relevant and fills creator·followers·date·likes·views·paid·location·caption·link; new Sheet each run; WhatsApp you; every Monday 08:00. ≈ 90 credits and ≈ ₹15 of AI per run. Create?"

Different ask → different questions: a GitHub "tell me when a competitor releases" job would ask which repos and what counts as a release, and propose a Watch, because the know-how says releases are a list with stable ids.

## Entry points
- **New agent** (Agents home) → this builder.
- **Make it an agent** (Social result) → this builder, with the sample already in hand ("You just ran X and got 12 rows — is this the kind of thing you want, and how much of it?"). The pre-filled form stays one tap away for "repeat exactly this call".
- **Chat**: "make this an agent" → same.

## Guard-rails
- Sample calls capped (3 / 5 credits) and shown; reads only; gates apply.
- Design budget capped per conversation (tokens and turns); when over, it proposes the best plan it has.
- The plan is what runs — the runner executes the plan JSON, and the picture is drawn from it; editing the plan re-plans, never forks.
- Cost estimate is derived, not guessed: pages × real credits per page from the know-how, items × tokens per item from measured runs; shown again as actual after the first run.

## Build order (issues to file after approval)
1. **Know-how layer** — `ToolKnowledge` cards from spec + `ToolCall` history + notes; health; `GET /api/tools/knowledge/:id`; tests.
2. **Planning blocks** — pages per source; creators-first; the plan JSON the direct runner executes; flow-drawer reads it; tests.
3. **Sample calls for the builder** — `runKind:'builder'`, caps, shown in chat; tests.
4. **The thinking builder** — Sonnet 5 `agent-builder` helper, prompt rebuilt around know-how + samples + planning blocks; questions-from-facts; plan-with-cost JSON; tests incl. "two requirements → different questions".
5. **Screens** — plan-with-cost + Create; Social "Make it an agent" and New agent routed through it; form kept as "repeat exactly this"; visual gate 1180/390.
6. **Acceptance** — the owner's example, again, through the builder: plan proposes hashtags + creators-first, ≥100 dated posts when the vendor's search is up, cost estimate within ±30% of actual, WhatsApp delivered.

## Out of scope
Making the India filter perfect (recall over precision stays); Bookmarks/Radar off Apify; a visual flow editor for direct-runner plans (the picture is drawn, not drawn on).
