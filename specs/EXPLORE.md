# My Brain — Explore (semantic index) — what we're building (and why)

A **unified semantic index** for everything in My Brain — an "Apple iOS27-style" index that understands *meaning*, not just keywords, running entirely on the owner's own VPS. The owner asks a plain-English question and gets a real, synthesised answer with sources, plus a brain that knows the people, projects, topics, commitments and decisions across their whole life.

## Why
The owner has a lot of content and it's growing fast. The point of a second brain is *retrieval that actually works*. Keyword search misses things; the owner can't remember exact words months later — but they remember **context** ("the day I argued pricing with Diksha"). The day's **Story + Tasks** carry that context, so they become the index *into* everything else. High-value future sources — **research**, **Capture documents**, **Bookmarks**, **Google Docs** — must be deeply findable. **Vaults** (passwords/wallets) are coming and are the most sensitive thing in the app.

## How it works (the engine)
**Decision (after a code+data audit, 2026-06-18):** the app ALREADY has a self-hosted vector index — the `rag-mcp` service (Postgres + pgvector + **HNSW**, OpenAI `text-embedding-3-small` 1536-dim). The vector engine is sound and fast (the *fast* part). We REUSE it as the one unified index rather than adding a `sqlite-vec` 4th store (which would worsen the "one brain, not four" goal). **The real problem is the indexing *layer* around it is half-finished and leaky — Phase 1 rebuilds that layer.**

What the audit found broken (live data: 85 of 85 Tasks indexed = 0; 30 of 94 docs missing from RAG; long-doc truncation):
- **Long content loses its tail** — embeddings truncate at 8000 chars (`rag-mcp/src/main.py:155`) and the app only calls whole-doc `save_doc` (`rag.store.ts:31`); the heading-aware chunking pipeline (`save_chunked_doc`/`search_chunked_docs`) is built but **never wired**.
- **Coverage gaps** — Tasks, Notes, DayNotes, BrainDumps, GmailBriefs, Mentor outputs, starred answers, people-memory are never indexed.
- **Silent loss** — a failed outbox row goes `status='failed'` after 3 tries and is never retried; `retryFailed()` has no caller/route; no reconcile job.
- **Narrow retrieval** — strict tag-scoping with no whole-brain fallback; SuperMemory-first short-circuit drops better RAG hits; hit limits of 3–5; returned hits sliced to 2200 chars.
- **Slow** — `rag.store.ts` opens a fresh MCP/SSE connection on *every* save and search (no pooling).

- **Embeddings:** OpenAI `text-embedding-3-small` (existing). Cheap. Vault text is NEVER sent to OpenAI.
- **Index:** existing `rag-mcp` (pgvector + HNSW), self-hosted, covered by backups. Designed so the engine can be swapped later with no app changes.
- **Answers:** Claude Sonnet reads the top retrieved passages and writes the answer *with sources* (RAG).
- **Entity & commitment graph:** Claude Haiku extracts people / projects / topics / documents / **commitments & decisions** from Story/Tasks/docs into linked Prisma tables.
- **Ranking:** relevance × recency × importance.
- All self-hosted behind the owner's login. The index is the most sensitive thing in the app and gets no new exposure.

## Sources (by priority)
- **Spine (index first + best):** Story · Tasks — the day's context, the index *into* everything.
- **High-value, deep index:** Research · Capture documents (uploads/PDFs · web articles · Notion imports) · Bookmarks (+ highlights/collections) · Google Docs (when integrated).
- **Also indexed:** notes · ideas · emails · people.
- **Vaults (later):** label-only, fully local — found by name via on-device matching; secret values NEVER embedded, NEVER sent to OpenAI, NEVER in the searchable index.

## Experience (acceptance, by area)
- **Explore ask-bar:** the existing **Find** page is upgraded into the Explore ask-bar. Ask anything in plain English → a synthesised answer from Sonnet with clickable sources, plus the ranked matches. Keyword-meaning hybrid. (Chat stays separate for back-and-forth.)
- **Entity browser:** browse people / projects / topics / documents — each with what the brain knows and where it came from.
- **Commitments & decisions view:** auto-extracted, *conservative* (only clear ones) — "send Diksha the quote by Friday" (commitment), "going with the rust design" (decision). Owner confirms or dismisses; no noise.
- **Connections:** conservative proactive surfacing of related items across sources.
- **Ambient:** daily digest · pre-meeting briefs (via Calendar) · Telegram nudges — reuses the existing daily-loop + Telegram plumbing.

## Decisions (locked)
- **One brain, not four:** the new `sqlite-vec` index becomes the primary index; the overlapping roles of RAG / SuperMemory / Honcho are absorbed **gradually** — kept running until the new index is proven, so nothing breaks mid-flight.
- **Backfill at launch:** index all existing Stories, Tasks, documents, bookmarks once, so Explore is useful on day one.
- **Vaults excluded** from the index (label-only local matching when that feature lands).
- **Embeddings:** OpenAI now, designed to swap to a local model later if sensitive data dominates.

## Build order (flat Linear issues per task)
- **Phase 1 — Rebuild the index layer (the foundation) on the existing engine:**
  - **BEA-330** — Chunked, full-content indexing + pooled RAG connection (long docs never truncated; fast).
  - **BEA-331** — Index everything + backfill (Tasks + Story first, then the missing types).
  - **BEA-333** — Index repair/reconcile job + retry route (never silently lose an item).
  - **BEA-332** — Whole-brain retrieval: query both stores, dedup, re-rank (relevance × recency × importance), raise limits, whole-brain fallback.
  - **BEA-334** — Explore ask-bar: upgrade Find into the ask-bar with Sonnet answers + sources, on a now-trustworthy index.
- **Phase 2 — High-value sources + graph:** deep-index Research · Capture documents · Bookmarks · (Google Docs); build the entity + commitments/decisions graph + views.
- **Phase 3 — Connections:** conservative cross-source connection surfacing.
- **Phase 4 — Ambient:** daily digest · pre-meeting briefs · Telegram nudges. Vaults slot in here (label-only) when built.

## Standards (always)
Responsive · consistent design · dark mode · accessible · fast · injection-safe retrieval · friendly errors · search/filter/sort/pagination on lists (entity browser, commitments). Single-user auth; the index never leaves the server; vaults never enter it.

## Out of scope (for now)
Multi-user · ripping out RAG/SuperMemory/Honcho abruptly (gradual absorption only) · vault indexing of secret values (ever) · local embedding model (designed-for, not built yet).
