-- CreateTable: Documents library (BEA-532)
CREATE TABLE "Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'md',
    "mime" TEXT,
    "filename" TEXT,
    "contentText" TEXT,
    "filePath" TEXT,
    "bytes" INTEGER,
    "sourceUrl" TEXT,
    "originServer" TEXT,
    "collectionId" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Document_slug_key" ON "Document"("slug");
CREATE INDEX "Document_kind_idx" ON "Document"("kind");
CREATE INDEX "Document_collectionId_idx" ON "Document"("collectionId");
