-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "content" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'created',
    "platform" TEXT NOT NULL DEFAULT 'code',
    "downloadUrl" TEXT,
    "filePath" TEXT,
    "slug" TEXT,
    "source" TEXT,
    "inUse" BOOLEAN,
    "installed" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" DATETIME,
    "usageCount" INTEGER NOT NULL DEFAULT 0,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "supermemoryId" TEXT,
    "ragId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
