-- NOTE: this migration is intentionally ADDITIVE ONLY. `prisma migrate dev` also wanted to
-- drop 7 pre-existing indexes (Note/SuggestedTask/UsageLog/VaultAudit/VaultItem) that exist in
-- the DB but were removed from schema.prisma long ago without a migration (pre-existing drift,
-- unrelated to the Agent feature). Those DROP INDEX statements were removed by hand so this
-- migration only CREATEs the new Agent runtime tables and never touches other features.

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "description" TEXT,
    "autonomy" TEXT NOT NULL DEFAULT 'cautious',
    "skills" TEXT NOT NULL DEFAULT '[]',
    "schedule" TEXT,
    "scheduleText" TEXT,
    "outputDest" TEXT NOT NULL DEFAULT 'document',
    "collectionId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "input" TEXT,
    "sessionId" TEXT,
    "stepLog" TEXT NOT NULL DEFAULT '[]',
    "outputDocId" TEXT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "AgentRun_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Waitpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'choice',
    "options" TEXT NOT NULL DEFAULT '[]',
    "defaultValue" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "answer" TEXT,
    "resumeToken" TEXT NOT NULL,
    "answeredVia" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" DATETIME,
    CONSTRAINT "Waitpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AgentRun_agentId_idx" ON "AgentRun"("agentId");

-- CreateIndex
CREATE INDEX "AgentRun_status_idx" ON "AgentRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_resumeToken_key" ON "Waitpoint"("resumeToken");

-- CreateIndex
CREATE INDEX "Waitpoint_runId_idx" ON "Waitpoint"("runId");

-- CreateIndex
CREATE INDEX "Waitpoint_status_idx" ON "Waitpoint"("status");
