-- Per-section index control: enable/disable + last-indexed time. (BEA-335)
CREATE TABLE "IndexSource" (
  "type" TEXT NOT NULL PRIMARY KEY,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "lastIndexedAt" DATETIME,
  "updatedAt" DATETIME NOT NULL
);
-- Notes can now be (optionally) indexed; link columns like the other sources.
ALTER TABLE "Note" ADD COLUMN "supermemoryId" TEXT;
ALTER TABLE "Note" ADD COLUMN "ragId" TEXT;
