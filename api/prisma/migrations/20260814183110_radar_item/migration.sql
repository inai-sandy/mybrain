-- CreateTable
CREATE TABLE "RadarItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "titleOriginal" TEXT NOT NULL,
    "translated" BOOLEAN NOT NULL DEFAULT false,
    "pendingTranslation" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT '',
    "aiScore" REAL NOT NULL DEFAULT 0,
    "storyId" TEXT NOT NULL DEFAULT '',
    "sources" TEXT NOT NULL DEFAULT '[]',
    "isPick" BOOLEAN NOT NULL DEFAULT false,
    "whyItMatters" TEXT,
    "publishedAt" DATETIME NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RadarSync" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "lastSyncAt" DATETIME,
    "lastOkAt" DATETIME,
    "lastError" TEXT,
    "counts" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "RadarItem_publishedAt_idx" ON "RadarItem"("publishedAt");

-- CreateIndex
CREATE INDEX "RadarItem_pendingTranslation_publishedAt_idx" ON "RadarItem"("pendingTranslation", "publishedAt");
