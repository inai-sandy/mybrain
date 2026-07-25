-- BEA-1095: agents-as-areas backbone.
-- New AgentArea table (the container the owner calls "an agent"); existing Agent rows become JOBS.
CREATE TABLE "AgentArea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "icon" TEXT,
    "color" TEXT,
    "description" TEXT,
    "tools" TEXT NOT NULL DEFAULT '[]',
    "sourceUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Per-job settings on Agent (each job fully independent).
ALTER TABLE "Agent" ADD COLUMN "areaId" TEXT;
ALTER TABLE "Agent" ADD COLUMN "notifyWhatsApp" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Agent" ADD COLUMN "keepDays" INTEGER;
ALTER TABLE "Agent" ADD COLUMN "engine" TEXT;
ALTER TABLE "Agent" ADD COLUMN "chatLog" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Agent" ADD COLUMN "indexToBrain" BOOLEAN NOT NULL DEFAULT false;

-- Data migration: every existing agent becomes its OWN one-job area (same name/icon/colour).
-- Nothing is lost; the owner can regroup jobs later via the move endpoint.
INSERT INTO "AgentArea" ("id","name","icon","color","description","tools","sourceUrl","createdAt","updatedAt")
SELECT 'area_' || "id", "name", "icon", "color", "description", '[]', "sourceUrl", "createdAt", CURRENT_TIMESTAMP FROM "Agent";
UPDATE "Agent" SET "areaId" = 'area_' || "id";
