-- Important emails stored in memory (BEA-439). PK = Gmail message id (upsert, no dupes).
CREATE TABLE "EmailMemory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "threadId" TEXT NOT NULL,
  "fromAddr" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "sentAt" DATETIME,
  "snippet" TEXT,
  "body" TEXT,
  "supermemoryId" TEXT,
  "ragId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "EmailMemory_day_idx" ON "EmailMemory"("day");
