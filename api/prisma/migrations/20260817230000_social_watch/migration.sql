-- AlterTable (BEA-1358): Watch / Alert on a direct-fetch job + why it paused itself
ALTER TABLE "Agent" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'run';
ALTER TABLE "Agent" ADD COLUMN "alertCondition" TEXT;
ALTER TABLE "Agent" ADD COLUMN "threshold" TEXT;
ALTER TABLE "Agent" ADD COLUMN "pausedReason" TEXT;

-- CreateTable (BEA-1358): what a Watch/Alert saw last time — one row per (job, action, arguments)
CREATE TABLE "SocialWatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "actionId" TEXT NOT NULL,
    "args" TEXT NOT NULL DEFAULT '{}',
    "argsHash" TEXT NOT NULL,
    "lastHash" TEXT NOT NULL,
    "lastResult" TEXT NOT NULL,
    "lastAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "alertState" TEXT,
    "lastAlertedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialWatch_agentId_actionId_argsHash_key" ON "SocialWatch"("agentId", "actionId", "argsHash");
CREATE INDEX "SocialWatch_agentId_idx" ON "SocialWatch"("agentId");
