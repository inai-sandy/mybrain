-- CreateTable
CREATE TABLE "Idea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "rawDump" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "researchPrompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "supermemoryId" TEXT,
    "ragId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- AlterTable
ALTER TABLE "Item" ADD COLUMN "ideaId" TEXT;
