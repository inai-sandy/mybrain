# My Brain — technical plan (the "how")

## Stack (all TypeScript)
- **Frontend:** React + Vite + Tailwind CSS (responsive, dark mode). Built to static assets.
- **Backend:** NestJS (single service) — REST API + background workers + scheduler + Telegram bot.
- **DB:** SQLite via Prisma (type-safe). DB file on a persisted Docker volume.
- **Packaging:** one multi-stage Docker image; the NestJS server serves the API under `/api/*` and the built React app for everything else.
- **Runtime on VPS:** container `mybrain-app` on `mcp-network`, behind Caddy at `mybrain.1site.ai` (auto-HTTPS).

## Memory
- **Primary:** SuperMemory (cloud) via its API; key from the Connector Registry.
- **Second store:** the on-server **RAG MCP** (`rag-mcp:8050` on `mcp-network`, pgvector, OpenAI embeddings) — reused as the self-hosted store in place of Mem0.
- **Dual-write:** outbox table + worker; writes go to both, with retries; never left inconsistent. Documents stored verbatim; dedup by content hash + source.

## External services (keys in Connector Registry, encrypted)
SuperMemory · RAG (on-server, no external key) · Notion (integration token) · Telegram (bot token) · Raindrop (API token) · Anthropic (chat agent, last phase).

## Repo & deploy
- Private **GitHub** repo (owner: inai-sandy) + working copy on the VPS.
- One Linear issue → one branch → tested → `ship.sh` (test → deploy → confirm-live) → merged → issue closed.
- Deploy = build image, run on `mcp-network`, add/confirm Caddy route, reload Caddy, health-check `https://mybrain.1site.ai`.

## Conventions
Organised & documented · reuse-don't-repeat (shared UI kit + shared backend modules) · built to grow · all the Standards baked into the shared UI from the shell onward.
