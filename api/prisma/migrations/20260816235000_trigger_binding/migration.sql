-- CreateTable
CREATE TABLE "TriggerBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerInstanceId" TEXT,
    "flowId" TEXT,
    "agentId" TEXT,
    "config" TEXT,
    "accountId" TEXT,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rateCap" INTEGER NOT NULL DEFAULT 20,
    "lastFiredAt" DATETIME,
    "pausedReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "TriggerEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bindingId" TEXT,
    "service" TEXT NOT NULL,
    "triggerType" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "runId" TEXT,
    "summary" TEXT,
    "echoOfId" TEXT,
    "payload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "TriggerBinding_service_idx" ON "TriggerBinding"("service");

-- CreateIndex
CREATE INDEX "TriggerBinding_triggerType_idx" ON "TriggerBinding"("triggerType");

-- CreateIndex
CREATE INDEX "TriggerEvent_bindingId_createdAt_idx" ON "TriggerEvent"("bindingId", "createdAt");

-- CreateIndex
CREATE INDEX "TriggerEvent_createdAt_idx" ON "TriggerEvent"("createdAt");

-- AlterTable: what a run was started with, when something outside handed it material (BEA-1350).
ALTER TABLE "FlowRun" ADD COLUMN "input" TEXT;
