-- BEA-1386: `ToolSample` — whole vendor answers, kept for worker tests and repairs.
-- Additive only: a new table and three indexes. No existing row or column is touched.

CREATE TABLE "ToolSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "agentId" TEXT,
    "argsHash" TEXT NOT NULL,
    "arguments" TEXT NOT NULL,
    "payload" BLOB NOT NULL,
    "bytes" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'good',
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ToolSample_actionId_kind_createdAt_idx" ON "ToolSample"("actionId", "kind", "createdAt");
CREATE INDEX "ToolSample_agentId_idx" ON "ToolSample"("agentId");
CREATE INDEX "ToolSample_argsHash_idx" ON "ToolSample"("argsHash");

-- SQLite never gives deleted space back to the disk on its own: evicting 50 MB of samples would
-- leave the file exactly as big, and the nightly `.backup` + gzip would keep copying it for ever.
-- INCREMENTAL lets the sweep hand the free pages back with `PRAGMA incremental_vacuum`. The setting
-- only takes hold after a VACUUM, which is why one runs here — once, on a database that has no
-- ToolSample rows in it yet.
PRAGMA auto_vacuum = INCREMENTAL;
VACUUM;
