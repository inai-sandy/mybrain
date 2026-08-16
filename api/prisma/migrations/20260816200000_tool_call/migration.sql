-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT,
    "runKind" TEXT,
    "agentId" TEXT,
    "nodeId" TEXT,
    "service" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "accountId" TEXT,
    "arguments" TEXT,
    "result" TEXT,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "ms" INTEGER,
    "gated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ToolCall_service_createdAt_idx" ON "ToolCall"("service", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCall_runId_idx" ON "ToolCall"("runId");

-- CreateIndex
CREATE INDEX "ToolCall_createdAt_idx" ON "ToolCall"("createdAt");
