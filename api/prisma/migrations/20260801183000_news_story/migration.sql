-- AlterTable
ALTER TABLE "NewsIssue" ADD COLUMN "extractedCount" INTEGER;
ALTER TABLE "NewsIssue" ADD COLUMN "splitAt" DATETIME;
ALTER TABLE "NewsIssue" ADD COLUMN "storyCount" INTEGER;

-- CreateTable
CREATE TABLE "NewsStory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "issueId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sectionPath" TEXT NOT NULL DEFAULT '',
    "theme" TEXT,
    "text" TEXT NOT NULL,
    "html" TEXT NOT NULL,
    "links" TEXT NOT NULL DEFAULT '[]',
    "category" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NewsStory_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "NewsIssue" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "NewsStory_issueId_idx" ON "NewsStory"("issueId");

-- CreateIndex
CREATE INDEX "NewsStory_issueId_kind_idx" ON "NewsStory"("issueId", "kind");

