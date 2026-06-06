# My Brain — what we're building (and why)

A **private, single-user, self-hosted "second brain"** at **mybrain.1site.ai** — one place to keep and retrieve research notes, bookmarks, highlights, and daily tasks. Built for one person (the owner) to run on their own VPS. Not a SaaS.

## Why
The owner aggregates research across many sources and has abandoned task apps before. The biggest risk is *building it and not using it* — so the daily task loop is prioritised, and everything is kept fast and genuinely useful.

## What it does (acceptance, by area)
- **Capture (3 doors):** upload a markdown file · pull a Notion page (→ markdown) · paste a public markdown URL. Stored on the server filesystem (source of truth), de-duplicated by content hash + source, "snapshot once" (no ongoing sync).
- **Memory (dual-write):** every stored doc is written to **both** SuperMemory (cloud, primary) and the self-hosted **RAG** store on the VPS, via a safe queue-and-retry "outbox" so the two never silently disagree.
- **Retrieve:** **search** (raw ranked results, injection-safe, no synthesis) and later a **chat assistant** (Claude agent with confirm-gated write tools).
- **Tasks:** create from web or Telegram, optional due dates, **auto-rollover** of unfinished tasks to the next day, **daily Telegram digest**, mark complete via bot or button.
- **Bookmarks:** poll **Raindrop** (~15 min, read-only) and file highlights/bookmarks into the brain.
- **Connector Registry:** all service credentials, encrypted at rest, behind auth.

## Standards (always)
Responsive (phone + desktop) · consistent design · dark mode · accessible · fast · confirm-before-delete · friendly errors · validation · search/filter/sort/pagination on lists. Secrets encrypted; search injection-safe; single-user auth with auto-logout.

## Out of scope (for now)
Multi-user / SaaS · keeping ingested content in sync after first snapshot · a separate staging environment (deploy straight to live — no users yet).
