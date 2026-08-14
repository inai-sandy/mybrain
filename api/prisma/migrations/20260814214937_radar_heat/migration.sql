-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RadarItem" (
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
    "heat" INTEGER NOT NULL DEFAULT 1,
    "whyItMatters" TEXT,
    "publishedAt" DATETIME NOT NULL,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_RadarItem" ("aiScore", "category", "firstSeenAt", "id", "isPick", "lastSeenAt", "pendingTranslation", "publishedAt", "source", "sources", "storyId", "title", "titleOriginal", "translated", "url", "whyItMatters") SELECT "aiScore", "category", "firstSeenAt", "id", "isPick", "lastSeenAt", "pendingTranslation", "publishedAt", "source", "sources", "storyId", "title", "titleOriginal", "translated", "url", "whyItMatters" FROM "RadarItem";
DROP TABLE "RadarItem";
ALTER TABLE "new_RadarItem" RENAME TO "RadarItem";
CREATE INDEX "RadarItem_publishedAt_idx" ON "RadarItem"("publishedAt");
CREATE INDEX "RadarItem_pendingTranslation_publishedAt_idx" ON "RadarItem"("pendingTranslation", "publishedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
