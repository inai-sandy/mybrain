-- CreateTable
CREATE TABLE "EmoCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lane" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'cooking',
    "title" TEXT,
    "summary" TEXT,
    "detail" TEXT,
    "links" TEXT NOT NULL DEFAULT '[]',
    "needsQuestion" TEXT,
    "needsOptions" TEXT NOT NULL DEFAULT '[]',
    "needsAnswer" TEXT,
    "source" TEXT NOT NULL DEFAULT 'emo',
    "day" TEXT NOT NULL,
    "rawTranscript" TEXT,
    "audioPath" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "EmoCard_day_idx" ON "EmoCard"("day");

-- CreateIndex
CREATE INDEX "EmoCard_status_idx" ON "EmoCard"("status");

-- CreateIndex
CREATE INDEX "EmoCard_lane_idx" ON "EmoCard"("lane");
