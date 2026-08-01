-- CreateTable
CREATE TABLE "NewsIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "link" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pubDate" DATETIME NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "rawHtml" TEXT,
    "entities" TEXT NOT NULL DEFAULT '[]',
    "summaryOnly" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "filledAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsIssue_link_key" ON "NewsIssue"("link");

-- CreateIndex
CREATE INDEX "NewsIssue_pubDate_idx" ON "NewsIssue"("pubDate");

-- CreateIndex
CREATE INDEX "NewsIssue_summaryOnly_idx" ON "NewsIssue"("summaryOnly");
