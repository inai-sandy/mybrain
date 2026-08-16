-- CreateTable
CREATE TABLE "ServiceGate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "service" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'once',
    "runId" TEXT,
    "nodeId" TEXT,
    "decision" TEXT NOT NULL DEFAULT 'approved',
    "arguments" TEXT,
    "question" TEXT,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ServiceGate_service_action_idx" ON "ServiceGate"("service", "action");

-- CreateIndex
CREATE INDEX "ServiceGate_runId_nodeId_idx" ON "ServiceGate"("runId", "nodeId");
