-- BEA-1024: a claim is someone SAYING a task is finished. It is never a completion —
-- the owner confirms. Purely additive: one new table, no existing table is rebuilt.

-- CreateTable
CREATE TABLE "TaskClaim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "contactId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'whatsapp',
    "quote" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME,
    CONSTRAINT "TaskClaim_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskClaim_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TaskClaim_status_idx" ON "TaskClaim"("status");

-- CreateIndex
CREATE INDEX "TaskClaim_taskId_idx" ON "TaskClaim"("taskId");

-- CreateIndex
CREATE INDEX "TaskClaim_contactId_idx" ON "TaskClaim"("contactId");

