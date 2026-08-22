-- BEA-1390: the build turn — one row per Codex build of an agent's worker.
-- Additive only: one new table. Nothing existing changes, so every live agent keeps running exactly
-- as it does today; a job has no worker until a build turn promotes one.

CREATE TABLE "WorkerBuild" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "origin" TEXT NOT NULL DEFAULT 'build',
    "reason" TEXT,
    "planHash" TEXT NOT NULL,
    "kit" TEXT NOT NULL DEFAULT '1',
    "tests" TEXT,
    "sampleIds" TEXT NOT NULL DEFAULT '[]',
    "sessionId" TEXT,
    "error" TEXT,
    "log" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- The newest promoted row for a job IS its live worker, so both lookups are by agent and by status.
CREATE INDEX "WorkerBuild_agentId_startedAt_idx" ON "WorkerBuild"("agentId", "startedAt");
CREATE INDEX "WorkerBuild_status_idx" ON "WorkerBuild"("status");
