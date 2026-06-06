# My Brain — task list (all features, build order)

One flat Linear issue per task. Never sub-tickets. "Done" = merged AND deployed live AND confirmed.
Linear project: **My Brain — Personal Second Brain** (team BEA).

## Batch 1 — Groundwork  *(issues created)*
- [x] **BEA-5** — Project skeleton live at mybrain.1site.ai  ✅ deployed + verified live
- [x] **BEA-6** — Database schema (SQLite + Prisma)  ✅ deployed + verified
- [x] **BEA-7** — Single-user authentication  ✅ deployed + verified (login live)
- [x] **BEA-8** — Connector Registry (encrypted credential store)  ✅ deployed + verified
- [ ] **BEA-9** — Memory dual-write engine (SuperMemory + RAG via outbox)
- [ ] **BEA-10** — Responsive app shell + standards baseline

## Batch 2 — Markdown files  *(issues created when Batch 1 ships)*
- [ ] Upload a markdown file → store on filesystem + DB metadata + dedup by hash
- [ ] Paste a public markdown URL → fetch → store
- [ ] Pull a Notion page → convert to markdown → store
- [ ] Dual-write every stored doc into SuperMemory + RAG (via the outbox)
- [ ] Tag suggestions on ingest
- [ ] Search — SuperMemory primary + RAG fallback, injection-safe, with standard list UI

## Batch 3 — Task loop
- [ ] Tasks: create (web), list, edit, complete, delete (with due dates)
- [ ] Auto-rollover of incomplete tasks to next day (rollover count)
- [ ] Telegram bot: create + complete tasks
- [ ] Scheduler + daily Telegram digest at chosen time(s)

## Batch 4 — Raindrop sync
- [ ] Raindrop polling worker (~15 min, read-only) → file bookmarks/highlights into the brain

## Batch 5 — Connector Registry UI
- [ ] Page to view/manage all service keys safely

## Batch 6 — Chat assistant (last)
- [ ] Claude chat agent (agentic mode) with confirm-gated write tools (tasks, ingestion, Notion, Raindrop)
- [ ] Chat sessions + learns preferences (RAG infer) + agent action audit log

## Notes
- Deploy steps captured once in `.claude/checks/deploy.sh` (+ `healthcheck.sh`) — see DEPLOY.md.
- Test command in `.claude/checks/test-command`.
