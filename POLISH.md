# My Brain — polish pass

Module-by-module polish, run by `/polish-mybrain`.
For each module: read the code → plain-English brief → my weakness list → owner's real-use input →
file flat Linear issues → build + ship them → mark built.

Legend: `—` not covered · `discussed` · `filed` · `built`
Map generated from code on 2026-07-21 (`web/src/App.tsx` routes + `api/src/*` + all background timers).

| # | Module | What it covers | Status | Issues | Date |
|---|--------|----------------|--------|--------|------|
| 1 | Today & Tasks | `/today`, `/tasks` · `tasks/` · brain-dump parse, rollover, duplicates, by-person | filed | BEA-1019, 1038 (delegation half) | 2026-07-21 |
| 2 | EMO | `/emo` · `emo/` · ask/talk/capture router, 6 card lanes, device turn + TTS | — | | |
| 3 | Activity, Day Close & Story | `/activity`, CloseDay, DailyStory · `daily/` · day summary, story, month/year, personality | — | | |
| 4 | Capture & Items | `/capture`, `/doc/:id`, `/view/:id` · `items/` · upload, URL, Notion, Supermemory import, share | — | | |
| 5 | Explore | `/explore` · `explore/` · whole-brain + web ask (Tavily), saved answers, sources, rechunk | — | | |
| 6 | Chat | `/chat`, `/chat/:id` · `chat/` · sessions, streaming, star/pin, retention, per-doc chat | — | | |
| 7 | Documents | `/documents`, `/d/:slug`, `/s/:code` · `documents/` · library, collections, public pages, export | — | | |
| 8 | Notes & Ideas | `/notes`, `/ideas` · `notes/`, `ideas/` · CRUD, AI format, idea workflow docs | — | | |
| 9 | Bookmarks | `/bookmarks` · `bookmarks/` · Raindrop sync, Instagram/Apify enrichment, summaries | — | | |
| 10 | Contacts & Reminders | `/contacts`, `/reminders` · `contacts/` · WhatsApp via Postbox, reminder agent, threads | filed | BEA-1019 → 1038 | 2026-07-21 |
| 11 | Meetings | `/meetings` · `meetings/` · records, transcription, audio retention, share | — | | |
| 12 | Google Workspace | `/google/*` · `google/` · Gmail brief + requests, Drive, Calendar, Docs/Sheets/Slides, Tasks | — | | |
| 13 | Recordings & Voice | `/recordings` · `recordings/`, `voice/` · chunked upload, marks, dictation, STT/TTS engines | — | | |
| 14 | Lab | `/lab` · `mind/`, `mentor/`, `accountability/` · findings, chains, review, weekly mentor | — | | |
| 15 | Agents & Flows | `/agent/*`, `/flows/*` · `agent/`, `hermes/`, `flows/` · Codex engine, HITL, evals, schedules | — | | |
| 16 | Skills | `/skills` · `skills/` · GitHub import, deploy to targets, packs, share | — | | |
| 17 | Vault | `/vault` · `vault/` · E2E secrets, devices, biometric unlock, encrypted files, audit | — | | |
| 18 | Dashboard & navigation | `/` · `home/`, `connections/` · "needs you" feed, AppShell, back nav, responsive, dark mode | — | | |
| 19 | Memory & the brain index | `memory/` · RAG + Supermemory queue, drain, reconcile, what's indexed vs dropped | — | | |
| 20 | Telegram | `telegram/` · bot commands, nudges, voice pref, backup reports | — | | |
| 21 | Settings, models & costs | `/settings` · `llm/`, `prompts/`, `connectors/`, `usage/`, `codex/`, `gemini/` | — | | |
| 22 | Security, sharing & MCP | `auth/`, `oauth/`, `public-mcp/` · login, device tokens, share links, MCP server | — | | |
| 23 | The night shift | All 20 background timers — what runs while you sleep, what it costs, what fails silently | — | | |

## Module 10 + 1 — the delegation redesign (discussed 2026-07-21)

Not a polish — a redesign of Contacts & Reminders into a **delegation and follow-through system**,
agreed with the owner through 12 recorded decisions. The reminder stops being the thing; the **task**
becomes the thing, and the reminder is just how it gets chased.

The loop: **brief a person → tasks owned by them → chases that repeat until done → they reply or tick
their own shared page → agent marks it claimed → you confirm → chase stops.** Plus neglect reporting,
contact-tagged brain indexing, EMO briefing/closing by voice, and confirm/reject on the device.

Build order (dependencies first):

1. `BEA-1019` real task↔person links + `@` mentions  ← everything depends on this
2. `BEA-1020` briefings
3. `BEA-1021` chases belong to a task, repeat until confirmed
4. `BEA-1024` agent marks the claimed task
5. `BEA-1025` review list (confirm / reject)
6. `BEA-1027` + `BEA-1028` the contact's shared short link, tick + note → review
7. `BEA-1029` delegated view · `BEA-1037` contact workspace
8. `BEA-1022` promised dates · `BEA-1030` stalling digest · `BEA-1023` agent context
9. `BEA-1031` brain indexing by contact
10. `BEA-1032` EMO brief lane · `BEA-1033` EMO closing intent · `BEA-1034` cards by person
11. `BEA-1035` device needs-you feed (server) → then `BEA-1036` firmware
12. `BEA-1026` + `BEA-1038` honesty fixes (promise ordering, the Telegram lie, dead columns)

Owner's recorded decisions: one owner + `@`others · briefings stack per contact · review inbox ·
chase repeats until confirmed · delegated work off the personal board · neglect = 3 chases with no
reply → daily digest · agent replies free but "done" needs the owner · brain gets tasks + briefings +
a rolling per-person summary (not raw chat) · briefing from wrist, phone and typed · one combined
WhatsApp message per person · a promised date drops the chase to once daily, never pauses · every
contact will have WhatsApp · shared page shows open **and** completed, tick + note, always approved.

## Standing pile (not part of the walk)

- **audit-sweep backlog** — 32 open findings from the 2026-07-04 read-through (2 medium, 30 low,
  `BEA-831`→`BEA-860` + `BEA-792`, `BEA-795`). Brought up inside the matching module as we go.
- **Stuck in progress** — `BEA-1013` (half-built on branch `sandypublic/bea-1013-task-dates`),
  `BEA-1012` (shipped, not closed), `BEA-488` (needs the owner on an iPhone).
