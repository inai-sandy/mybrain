-- The brief (BEA-1405) — what an agent is made from, in the owner's own words, before anything is built.
CREATE TABLE "AgentBrief" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "areaId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "name" TEXT NOT NULL DEFAULT '',
    "sections" TEXT NOT NULL DEFAULT '{}',
    "sources" TEXT NOT NULL DEFAULT '[]',
    "delivery" TEXT NOT NULL DEFAULT '{}',
    "transcript" TEXT NOT NULL DEFAULT '[]',
    "approvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "AgentBrief_areaId_version_idx" ON "AgentBrief"("areaId", "version");
CREATE INDEX "AgentBrief_areaId_status_idx" ON "AgentBrief"("areaId", "status");
