"""
RAG MCP Server v2 — verbatim document storage with semantic search and chunking.

Tools exposed:
  - save_doc:            Store a document verbatim (small notes, decisions)
  - save_chunked_doc:    Store a long document AND auto-chunk for precise retrieval
  - get_doc:             Retrieve a document by ID (returns full text)
  - search_docs:         Semantic search across whole docs only
  - search_chunked_docs: Semantic search across chunks, returns chunk + parent metadata
  - list_docs:           List recent documents (most recent first)
  - delete_doc:          Delete a document (and all its chunks if any)

Storage: Postgres with pgvector
Embeddings: OpenAI text-embedding-3-small (1536 dimensions)
Transport: SSE on /sse endpoint

Chunking strategy:
  - Split on markdown headings (#, ##, ###)
  - Heading-section becomes one chunk if <= ~800 tokens (~3200 chars)
  - Larger sections sub-split into ~500 token chunks (~2000 chars) with ~50 token overlap (~200 chars)
  - Parent doc stored with full content alongside chunks
"""

import os
import re
import json
import logging
from typing import Optional, List, Tuple
from uuid import uuid4

import asyncpg
from openai import AsyncOpenAI
from mcp.server.fastmcp import FastMCP, Context

# ---------- Logging ----------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("rag-mcp")

# ---------- Config from env ----------

DATABASE_URL = os.environ["DATABASE_URL"]
OPENAI_API_KEY = os.environ["OPENAI_API_KEY"]
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = int(os.environ.get("EMBEDDING_DIMENSIONS", "1536"))
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8050"))

# Chunking config (chars; ~4 chars per token for English text)
CHUNK_HEADING_MAX_CHARS = 3200   # ~800 tokens
CHUNK_SUBSPLIT_TARGET = 2000     # ~500 tokens
CHUNK_OVERLAP_CHARS = 200        # ~50 tokens

# ---------- Globals (lazy-initialized) ----------

_db_pool: Optional[asyncpg.Pool] = None
_openai_client: Optional[AsyncOpenAI] = None


# ---------- Database setup ----------

INIT_SQL = f"""
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
    id            UUID PRIMARY KEY,
    title         TEXT,
    content       TEXT NOT NULL,
    embedding     vector({EMBEDDING_DIMENSIONS}) NOT NULL,
    tags          TEXT[] DEFAULT '{{}}',
    is_chunk      BOOLEAN NOT NULL DEFAULT FALSE,
    parent_id     UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index   INTEGER,
    chunk_heading TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill columns if upgrading from v1 schema
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='documents' AND column_name='is_chunk') THEN
        ALTER TABLE documents ADD COLUMN is_chunk BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='documents' AND column_name='parent_id') THEN
        ALTER TABLE documents ADD COLUMN parent_id UUID REFERENCES documents(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='documents' AND column_name='chunk_index') THEN
        ALTER TABLE documents ADD COLUMN chunk_index INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='documents' AND column_name='chunk_heading') THEN
        ALTER TABLE documents ADD COLUMN chunk_heading TEXT;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS documents_embedding_idx
    ON documents USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS documents_created_at_idx
    ON documents (created_at DESC);

CREATE INDEX IF NOT EXISTS documents_tags_idx
    ON documents USING GIN (tags);

CREATE INDEX IF NOT EXISTS documents_parent_id_idx
    ON documents (parent_id) WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_is_chunk_idx
    ON documents (is_chunk);
"""


async def get_db_pool() -> asyncpg.Pool:
    """Lazy-init the database pool."""
    global _db_pool
    if _db_pool is None:
        _db_pool = await asyncpg.create_pool(
            DATABASE_URL,
            min_size=1,
            max_size=10,
            command_timeout=30,
        )
        log.info("Postgres pool created")
        async with _db_pool.acquire() as conn:
            await conn.execute(INIT_SQL)
        log.info("Database initialized — schema and indexes ready")
    return _db_pool


def get_openai() -> AsyncOpenAI:
    """Lazy-init the OpenAI client."""
    global _openai_client
    if _openai_client is None:
        _openai_client = AsyncOpenAI(api_key=OPENAI_API_KEY)
        log.info("OpenAI client initialized")
    return _openai_client


# ---------- Embedding helper ----------

async def embed(text: str) -> list[float]:
    """Generate OpenAI embedding vector for text."""
    if not text or not text.strip():
        raise ValueError("Cannot embed empty text")
    client = get_openai()
    response = await client.embeddings.create(
        model=EMBEDDING_MODEL,
        input=text[:8000],  # OpenAI input limit safety
    )
    return response.data[0].embedding


def vector_to_pg(vec: list[float]) -> str:
    """Convert Python list to pgvector string format."""
    return "[" + ",".join(str(x) for x in vec) + "]"


# ---------- Chunking logic ----------

HEADING_PATTERN = re.compile(r"^(#{1,3})\s+(.+?)$", re.MULTILINE)


def split_by_headings(content: str) -> List[Tuple[Optional[str], str]]:
    """
    Split markdown content on headings (#, ##, ###).
    Returns list of (heading, section_text) tuples.
    Section text includes the heading line + everything until next heading.
    First section may have heading=None if content doesn't start with a heading.
    """
    matches = list(HEADING_PATTERN.finditer(content))

    if not matches:
        # No headings — whole doc is one section
        return [(None, content)]

    sections = []

    # Pre-heading content (if any)
    if matches[0].start() > 0:
        pre = content[: matches[0].start()].strip()
        if pre:
            sections.append((None, pre))

    # Each heading + its content
    for i, match in enumerate(matches):
        heading = match.group(2).strip()
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(content)
        section_text = content[start:end].strip()
        sections.append((heading, section_text))

    return sections


def subsplit_text(text: str, target_chars: int, overlap_chars: int) -> List[str]:
    """
    Split a long text into overlapping windows of approximately target_chars each.
    Tries to break on paragraph (\n\n) or sentence (. ) boundaries when possible.
    """
    if len(text) <= target_chars:
        return [text]

    chunks = []
    pos = 0
    n = len(text)

    while pos < n:
        end = pos + target_chars
        if end >= n:
            chunks.append(text[pos:].strip())
            break

        # Try to break on paragraph or sentence boundary near `end`
        window = text[pos:end + 200]  # look ahead 200 chars for break point
        break_point = -1

        # Prefer paragraph break
        para_break = window.rfind("\n\n", target_chars - 200, target_chars + 200)
        if para_break > 0:
            break_point = pos + para_break + 2
        else:
            # Try sentence break
            sent_break = window.rfind(". ", target_chars - 200, target_chars + 200)
            if sent_break > 0:
                break_point = pos + sent_break + 2

        if break_point < 0 or break_point <= pos:
            # No good break — just cut at target
            break_point = pos + target_chars

        chunks.append(text[pos:break_point].strip())
        # Next chunk starts overlap_chars before this chunk's end
        pos = max(break_point - overlap_chars, pos + 1)

    return [c for c in chunks if c]


def chunk_document(
    content: str,
    heading_max: int = CHUNK_HEADING_MAX_CHARS,
    subsplit_target: int = CHUNK_SUBSPLIT_TARGET,
    overlap: int = CHUNK_OVERLAP_CHARS,
) -> List[Tuple[Optional[str], str]]:
    """
    Hybrid chunking: split by headings first, sub-split sections that are too large.
    Returns list of (heading, chunk_text) tuples in order.
    """
    sections = split_by_headings(content)
    chunks = []

    for heading, section_text in sections:
        if len(section_text) <= heading_max:
            chunks.append((heading, section_text))
        else:
            sub_chunks = subsplit_text(section_text, subsplit_target, overlap)
            for sub in sub_chunks:
                chunks.append((heading, sub))

    return chunks


# ---------- MCP server ----------

log.info(f"Starting RAG MCP server on {HOST}:{PORT}")
log.info(f"Embedding model: {EMBEDDING_MODEL} ({EMBEDDING_DIMENSIONS} dims)")

mcp = FastMCP(
    name="rag-mcp",
    host=HOST,
    port=PORT,
)


# ---------- Tools ----------

@mcp.tool()
async def save_doc(
    ctx: Context,
    content: str,
    title: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> str:
    """
    Save a document verbatim with semantic indexing — single embedding for whole doc.

    Use for: short notes, decisions, single facts, anything under ~2000 chars.
    For long research briefs, use save_chunked_doc instead — chunked retrieval is more precise.

    Args:
        content: The full text to store (required)
        title: Optional title for easy identification
        tags: Optional list of tags for filtering

    Returns:
        JSON with the new document's ID, title, char count, tag list.
    """
    if not content or not content.strip():
        return json.dumps({"error": "content cannot be empty"})

    doc_id = str(uuid4())
    title = (title or content.strip().split("\n")[0][:120]).strip()
    tags = tags or []

    try:
        embedding = await embed(content)
    except Exception as e:
        log.exception("Embedding failed")
        return json.dumps({"error": f"embedding failed: {str(e)}"})

    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO documents (id, title, content, embedding, tags, is_chunk)
                VALUES ($1, $2, $3, $4::vector, $5, FALSE)
                """,
                doc_id, title, content, vector_to_pg(embedding), tags,
            )
        log.info(f"Saved doc {doc_id} ({len(content)} chars, title: '{title[:60]}')")
        return json.dumps({
            "ok": True,
            "id": doc_id,
            "title": title,
            "chars": len(content),
            "tags": tags,
            "chunked": False,
        })
    except Exception as e:
        log.exception("Insert failed")
        return json.dumps({"error": f"insert failed: {str(e)}"})


@mcp.tool()
async def save_chunked_doc(
    ctx: Context,
    content: str,
    title: Optional[str] = None,
    tags: Optional[List[str]] = None,
) -> str:
    """
    Save a long document with auto-chunking for precise semantic retrieval.

    Splits content on markdown headings (#, ##, ###) and sub-splits long sections.
    The full parent doc is stored verbatim, plus each chunk gets its own embedding.
    Use search_chunked_docs to retrieve relevant sections; use get_doc with the
    parent_id to retrieve the full original brief.

    Use for: research briefs, long writeups, anything multi-topic over ~2000 chars.

    Args:
        content: Full text to store and chunk (required)
        title: Optional title for the parent doc
        tags: Optional list of tags (applied to parent and all chunks)

    Returns:
        JSON with parent_id, title, char count, chunks_created, tag list.
    """
    if not content or not content.strip():
        return json.dumps({"error": "content cannot be empty"})

    parent_id = str(uuid4())
    title = (title or content.strip().split("\n")[0][:120]).strip()
    tags = tags or []

    # Compute chunks first (cheap, no API calls yet)
    chunks = chunk_document(content)
    log.info(f"Chunked into {len(chunks)} pieces (parent {parent_id})")

    if len(chunks) == 0:
        return json.dumps({"error": "chunking produced zero chunks"})

    # Embed parent doc + all chunks
    try:
        parent_embedding = await embed(content)
        chunk_embeddings = []
        for heading, chunk_text in chunks:
            emb = await embed(chunk_text)
            chunk_embeddings.append(emb)
    except Exception as e:
        log.exception("Embedding failed during chunked save")
        return json.dumps({"error": f"embedding failed: {str(e)}"})

    # Insert parent + chunks in one transaction
    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Insert parent
                await conn.execute(
                    """
                    INSERT INTO documents (id, title, content, embedding, tags, is_chunk)
                    VALUES ($1, $2, $3, $4::vector, $5, FALSE)
                    """,
                    parent_id, title, content, vector_to_pg(parent_embedding), tags,
                )
                # Insert chunks
                for idx, ((heading, chunk_text), emb) in enumerate(zip(chunks, chunk_embeddings)):
                    chunk_id = str(uuid4())
                    chunk_title = f"{title} — {heading}" if heading else f"{title} — part {idx + 1}"
                    await conn.execute(
                        """
                        INSERT INTO documents
                            (id, title, content, embedding, tags, is_chunk,
                             parent_id, chunk_index, chunk_heading)
                        VALUES ($1, $2, $3, $4::vector, $5, TRUE, $6, $7, $8)
                        """,
                        chunk_id, chunk_title[:200], chunk_text,
                        vector_to_pg(emb), tags, parent_id, idx, heading,
                    )
        log.info(f"Saved chunked doc {parent_id}: {len(content)} chars → {len(chunks)} chunks")
        return json.dumps({
            "ok": True,
            "parent_id": parent_id,
            "title": title,
            "chars": len(content),
            "chunks_created": len(chunks),
            "tags": tags,
            "chunked": True,
        })
    except Exception as e:
        log.exception("Insert failed during chunked save")
        return json.dumps({"error": f"insert failed: {str(e)}"})


@mcp.tool()
async def get_doc(ctx: Context, doc_id: str) -> str:
    """
    Retrieve a document by ID, returning the full text verbatim.
    Works for both whole-doc saves and the parent of chunked saves.

    Args:
        doc_id: UUID of the document

    Returns:
        JSON with full content, title, tags, and timestamps.
    """
    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT id, title, content, tags, is_chunk, parent_id,
                       chunk_index, chunk_heading, created_at, updated_at
                FROM documents
                WHERE id = $1
                """,
                doc_id,
            )
        if row is None:
            return json.dumps({"error": f"no document with id {doc_id}"})
        return json.dumps({
            "id": str(row["id"]),
            "title": row["title"],
            "content": row["content"],
            "tags": list(row["tags"]) if row["tags"] else [],
            "is_chunk": row["is_chunk"],
            "parent_id": str(row["parent_id"]) if row["parent_id"] else None,
            "chunk_index": row["chunk_index"],
            "chunk_heading": row["chunk_heading"],
            "created_at": row["created_at"].isoformat(),
            "updated_at": row["updated_at"].isoformat(),
        })
    except Exception as e:
        log.exception("get_doc failed")
        return json.dumps({"error": f"fetch failed: {str(e)}"})


@mcp.tool()
async def search_docs(
    ctx: Context,
    query: str,
    limit: int = 5,
    min_similarity: float = 0.0,
) -> str:
    """
    Semantic search across whole documents only (excludes chunks).

    Returns whole-doc matches with FULL content. Use this when you want the
    complete picture, not just relevant sections. For precise multi-topic
    retrieval, use search_chunked_docs instead.

    Args:
        query: Natural-language search query
        limit: Max results (1-20, default 5)
        min_similarity: Minimum cosine similarity (0.0-1.0, default 0.0)

    Returns:
        JSON array with id, title, full content, tags, similarity, created_at.
    """
    if not query or not query.strip():
        return json.dumps({"error": "query cannot be empty"})

    limit = max(1, min(limit, 20))

    try:
        embedding = await embed(query)
    except Exception as e:
        log.exception("Query embedding failed")
        return json.dumps({"error": f"embedding failed: {str(e)}"})

    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    id, title, content, tags, created_at,
                    1 - (embedding <=> $1::vector) AS similarity
                FROM documents
                WHERE is_chunk = FALSE
                  AND 1 - (embedding <=> $1::vector) >= $2
                ORDER BY embedding <=> $1::vector
                LIMIT $3
                """,
                vector_to_pg(embedding), min_similarity, limit,
            )
        results = [
            {
                "id": str(r["id"]),
                "title": r["title"],
                "content": r["content"],
                "tags": list(r["tags"]) if r["tags"] else [],
                "similarity": round(float(r["similarity"]), 4),
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
        log.info(f"search_docs '{query[:60]}' → {len(results)} results")
        return json.dumps({"ok": True, "count": len(results), "results": results})
    except Exception as e:
        log.exception("search failed")
        return json.dumps({"error": f"search failed: {str(e)}"})


@mcp.tool()
async def search_chunked_docs(
    ctx: Context,
    query: str,
    limit: int = 5,
    min_similarity: float = 0.0,
) -> str:
    """
    Semantic search across chunks of chunked documents.

    Returns the most relevant CHUNKS (not whole docs) with parent metadata
    for context. To get the full original brief that a chunk came from,
    call get_doc with the chunk's parent_id.

    Use this for precise retrieval from long research briefs where different
    sections cover different topics.

    Args:
        query: Natural-language search query
        limit: Max chunks to return (1-20, default 5)
        min_similarity: Minimum cosine similarity (0.0-1.0, default 0.0)

    Returns:
        JSON array. Each result has:
          - chunk_id, chunk_content, chunk_heading, chunk_index
          - parent_id, parent_title, parent_tags
          - similarity, created_at
    """
    if not query or not query.strip():
        return json.dumps({"error": "query cannot be empty"})

    limit = max(1, min(limit, 20))

    try:
        embedding = await embed(query)
    except Exception as e:
        log.exception("Query embedding failed")
        return json.dumps({"error": f"embedding failed: {str(e)}"})

    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    c.id          AS chunk_id,
                    c.content     AS chunk_content,
                    c.chunk_heading,
                    c.chunk_index,
                    c.parent_id,
                    c.created_at,
                    p.title       AS parent_title,
                    p.tags        AS parent_tags,
                    1 - (c.embedding <=> $1::vector) AS similarity
                FROM documents c
                LEFT JOIN documents p ON c.parent_id = p.id
                WHERE c.is_chunk = TRUE
                  AND 1 - (c.embedding <=> $1::vector) >= $2
                ORDER BY c.embedding <=> $1::vector
                LIMIT $3
                """,
                vector_to_pg(embedding), min_similarity, limit,
            )
        results = [
            {
                "chunk_id": str(r["chunk_id"]),
                "chunk_content": r["chunk_content"],
                "chunk_heading": r["chunk_heading"],
                "chunk_index": r["chunk_index"],
                "parent_id": str(r["parent_id"]) if r["parent_id"] else None,
                "parent_title": r["parent_title"],
                "parent_tags": list(r["parent_tags"]) if r["parent_tags"] else [],
                "similarity": round(float(r["similarity"]), 4),
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
        log.info(f"search_chunked_docs '{query[:60]}' → {len(results)} results")
        return json.dumps({"ok": True, "count": len(results), "results": results})
    except Exception as e:
        log.exception("chunked search failed")
        return json.dumps({"error": f"search failed: {str(e)}"})


@mcp.tool()
async def list_docs(
    ctx: Context,
    limit: int = 20,
    tag: Optional[str] = None,
    include_chunks: bool = False,
) -> str:
    """
    List documents in reverse chronological order (newest first).
    By default returns only parent/whole docs (not chunks).

    Args:
        limit: Max docs (1-100, default 20)
        tag: Optional tag filter
        include_chunks: If True, also list chunks (default False)

    Returns:
        JSON array with id, title, char_count, tags, is_chunk, parent_id, created_at.
    """
    limit = max(1, min(limit, 100))

    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            conditions = []
            params = []
            param_idx = 1

            if not include_chunks:
                conditions.append("is_chunk = FALSE")

            if tag:
                conditions.append(f"${param_idx} = ANY(tags)")
                params.append(tag)
                param_idx += 1

            where_clause = "WHERE " + " AND ".join(conditions) if conditions else ""
            params.append(limit)

            sql = f"""
                SELECT id, title, LENGTH(content) AS chars, tags,
                       is_chunk, parent_id, chunk_index, created_at
                FROM documents
                {where_clause}
                ORDER BY created_at DESC
                LIMIT ${param_idx}
            """
            rows = await conn.fetch(sql, *params)

        results = [
            {
                "id": str(r["id"]),
                "title": r["title"],
                "chars": r["chars"],
                "tags": list(r["tags"]) if r["tags"] else [],
                "is_chunk": r["is_chunk"],
                "parent_id": str(r["parent_id"]) if r["parent_id"] else None,
                "chunk_index": r["chunk_index"],
                "created_at": r["created_at"].isoformat(),
            }
            for r in rows
        ]
        return json.dumps({"ok": True, "count": len(results), "docs": results})
    except Exception as e:
        log.exception("list failed")
        return json.dumps({"error": f"list failed: {str(e)}"})


@mcp.tool()
async def delete_doc(ctx: Context, doc_id: str) -> str:
    """
    Delete a document. If it's a parent of chunked content, all its chunks
    are also deleted (via ON DELETE CASCADE). Permanent — no undo.

    Args:
        doc_id: UUID of the document to delete

    Returns:
        JSON with deleted=true and chunks_deleted count.
    """
    try:
        pool = await get_db_pool()
        async with pool.acquire() as conn:
            # Count chunks that will be cascade-deleted
            chunk_count = await conn.fetchval(
                "SELECT COUNT(*) FROM documents WHERE parent_id = $1",
                doc_id,
            )
            result = await conn.execute(
                "DELETE FROM documents WHERE id = $1",
                doc_id,
            )
        deleted = result.split()[-1] == "1"
        if deleted:
            log.info(f"Deleted doc {doc_id} (and {chunk_count} chunks)")
            return json.dumps({
                "ok": True,
                "deleted": True,
                "id": doc_id,
                "chunks_deleted": chunk_count,
            })
        else:
            return json.dumps({"ok": False, "deleted": False, "error": "not found"})
    except Exception as e:
        log.exception("delete failed")
        return json.dumps({"error": f"delete failed: {str(e)}"})


# ---------- Entry point ----------

if __name__ == "__main__":
    mcp.run(transport="sse")
