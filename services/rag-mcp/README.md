# RAG MCP Server v2 — with chunking

> **This folder is the protected master copy.** The live service runs on srv929020 from
> `/root/rag-mcp-v2` (containers `rag-mcp` + `rag-postgres` on `mcp-network`). Secrets are
> NOT in these files — the running containers carry the real `POSTGRES_PASSWORD` and
> `OPENAI_API_KEY` in their environment (set via Portainer). If the code ever changes,
> change it HERE first, then copy to the server and rebuild.

Verbatim document storage with semantic search and **auto-chunking for long docs**.

## What's new in v2

- New tool: `save_chunked_doc` — stores a long doc verbatim AND auto-chunks it for precise retrieval
- New tool: `search_chunked_docs` — searches across chunks, returns chunks + parent doc metadata
- Updated tool: `list_docs` — now has `include_chunks` flag (default false)
- Updated tool: `delete_doc` — cascade deletes chunks when parent is deleted
- Schema migration: adds `parent_id`, `is_chunk`, `chunk_index`, `chunk_heading` columns

Existing v1 data is preserved — schema migration runs automatically on startup.

## Tools

| Tool | When to use |
|------|-------------|
| `save_doc` | Short notes, decisions, single facts. Under ~2000 chars. |
| `save_chunked_doc` | Long research briefs, multi-topic docs. Over ~2000 chars. |
| `get_doc` | Get any document (or chunk) by ID. Returns full text. |
| `search_docs` | Search whole docs only. Returns full content of matching docs. |
| `search_chunked_docs` | Search across chunks. Returns chunks + parent metadata. |
| `list_docs` | List parent docs (chunks excluded by default). |
| `delete_doc` | Delete by ID. Parent delete cascades to its chunks. |

## Chunking strategy

Hybrid: heading-based with token-based sub-splitting.

1. Split content on markdown headings (`#`, `##`, `###`)
2. If a heading-section is ≤ ~800 tokens (~3200 chars) → one chunk
3. If larger → sub-split into ~500-token chunks (~2000 chars) with ~50-token overlap (~200 chars)
4. Sub-splitting tries to break on paragraph (`\n\n`) or sentence (`. `) boundaries
5. Parent doc itself is also stored with full content + its own embedding

Tuning constants in `src/main.py`:
- `CHUNK_HEADING_MAX_CHARS` (default 3200)
- `CHUNK_SUBSPLIT_TARGET` (default 2000)
- `CHUNK_OVERLAP_CHARS` (default 200)

## How retrieval works

When you call `search_chunked_docs`:
- Searches only chunks (where `is_chunk = TRUE`)
- Returns top N matching chunks with similarity score
- Each result includes parent_id and parent_title so you can fetch full context

When you call `search_docs`:
- Searches only parent docs (where `is_chunk = FALSE`)
- Returns full content of matching docs
- Use this for "show me the brief that's about X overall"

Typical pattern:
1. Use `search_chunked_docs` to find precise sections
2. If a chunk looks promising but you need full context, call `get_doc` with the parent_id
3. Use `search_docs` if you want to find an entire brief, not specific sections

## Migration from v1

The schema migration is idempotent — runs on startup, adds new columns if missing, leaves existing data alone.

If you have v1 docs already saved, they'll behave correctly:
- They'll appear in `search_docs` (because `is_chunk` defaults to FALSE)
- They'll appear in `list_docs` without `include_chunks=True`
- They won't appear in `search_chunked_docs` (no chunks were created for them)

If you want a v1 doc to become chunked, call `save_chunked_doc` again with the same content. Old version stays put. You can delete the old one if you want.

## Deployment

### Fresh install
Same as v1. See main README in v1 for full steps.

### Upgrading from v1

1. Upload new files to VPS:
   ```bash
   scp ~/Downloads/rag-mcp-v2.tar.gz root@31.97.226.201:/root/
   ssh root@31.97.226.201
   cd /root
   tar xzf rag-mcp-v2.tar.gz
   ```

2. Rebuild image:
   ```bash
   cd rag-mcp-v2
   docker build -t rag-mcp:local .
   ```

3. Restart the rag-mcp container so it picks up the new image and runs the migration:
   ```bash
   docker restart rag-mcp
   docker logs --tail 30 rag-mcp
   ```

   Look for `Database initialized — schema and indexes ready` confirming migration ran.

4. No Caddy or DNS changes needed. No claude.ai connector changes needed.

5. Verify the new tools appear in claude.ai (refresh the connector or open a new chat). You should now see 7 tools instead of 5.

## Cost notes

`save_chunked_doc` costs more than `save_doc` because it generates one embedding per chunk plus one for the parent.
- `save_doc` on 17K-char brief: 1 embedding call (~$0.0001)
- `save_chunked_doc` on 17K-char brief with 8 chunks: 9 embedding calls (~$0.0009)

Trivial cost differences. Use the right tool for the size, don't worry about pennies.

## Inspecting via psql

```bash
docker exec -it rag-postgres psql -U rag -d rag
```

Useful queries:

```sql
-- Count parent docs vs chunks
SELECT is_chunk, COUNT(*) FROM documents GROUP BY is_chunk;

-- See parent docs with their chunk counts
SELECT
    p.id, p.title, p.tags,
    COUNT(c.id) AS chunk_count,
    LENGTH(p.content) AS parent_chars
FROM documents p
LEFT JOIN documents c ON c.parent_id = p.id
WHERE p.is_chunk = FALSE
GROUP BY p.id, p.title, p.tags, p.content
ORDER BY p.created_at DESC;

-- See chunks of a specific parent
SELECT chunk_index, chunk_heading, LENGTH(content) AS chars
FROM documents
WHERE parent_id = 'paste-parent-uuid-here'
ORDER BY chunk_index;
```
