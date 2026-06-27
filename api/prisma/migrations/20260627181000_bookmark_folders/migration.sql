-- Bookmark folders (My-Brain-owned, independent of Raindrop) (BEA-611)
ALTER TABLE "Item" ADD COLUMN "folderId" TEXT;
CREATE INDEX "Item_folderId_idx" ON "Item"("folderId");

CREATE TABLE "BookmarkFolder" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "color" TEXT,
  "icon" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
