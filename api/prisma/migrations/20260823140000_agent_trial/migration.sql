-- The trial run (BEA-1408) — he sees the real thing before Create is possible.
CREATE TABLE "AgentTrial" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "areaId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "briefVersion" INTEGER NOT NULL,
    "agentId" TEXT,
    "runId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'building',
    "rows" TEXT NOT NULL DEFAULT '[]',
    "columns" TEXT NOT NULL DEFAULT '[]',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '',
    "credits" INTEGER NOT NULL DEFAULT 0,
    "aiTokens" INTEGER NOT NULL DEFAULT 0,
    "verdict" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "AgentTrial_areaId_briefVersion_idx" ON "AgentTrial"("areaId", "briefVersion");
CREATE INDEX "AgentTrial_agentId_idx" ON "AgentTrial"("agentId");
