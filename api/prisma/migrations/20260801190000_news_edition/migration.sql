-- CreateTable
CREATE TABLE "NewsEdition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issueId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "day" TEXT NOT NULL,
    "headline" TEXT NOT NULL,
    "sixty" TEXT NOT NULL DEFAULT '[]',
    "sections" TEXT NOT NULL DEFAULT '[]',
    "storyCount" INTEGER NOT NULL DEFAULT 0,
    "engineOk" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '[]',
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- AlterTable
-- BEA-1258 "worth digging into". Prisma wanted to DROP and recreate NewsStory for this
-- (SQLite cannot alter a table with a foreign key in place, so it rewrites). A plain
-- ADD COLUMN does the same job and never touches the rows already stored.
ALTER TABLE "NewsStory" ADD COLUMN "flagged" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "NewsEdition_issueId_key" ON "NewsEdition"("issueId");

-- CreateIndex
CREATE UNIQUE INDEX "NewsEdition_number_key" ON "NewsEdition"("number");

-- CreateIndex
CREATE UNIQUE INDEX "NewsEdition_day_key" ON "NewsEdition"("day");

-- CreateIndex
CREATE INDEX "NewsEdition_createdAt_idx" ON "NewsEdition"("createdAt");

