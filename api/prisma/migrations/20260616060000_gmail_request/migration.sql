-- CreateTable
CREATE TABLE "GmailRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "query" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "threadId" TEXT,
    "threadSubject" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "emailCopy" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "shareId" TEXT,
    "itemId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "GmailRequest_shareId_key" ON "GmailRequest"("shareId");
