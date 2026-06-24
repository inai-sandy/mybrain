-- CreateTable
CREATE TABLE "MindChain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "goal" TEXT NOT NULL,
    "blocker" TEXT NOT NULL,
    "lever" TEXT NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "confidence" REAL NOT NULL DEFAULT 0.7,
    "validated" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenDay" TEXT,
    "lastSeenDay" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "MindChain_status_idx" ON "MindChain"("status");
