-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT 'Untitled meeting',
    "agenda" TEXT,
    "audioPath" TEXT,
    "audioMime" TEXT,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "engine" TEXT,
    "transcript" TEXT,
    "summary" TEXT,
    "takeaways" TEXT,
    "decisions" TEXT,
    "actionItems" TEXT,
    "language" TEXT,
    "savedToMemory" BOOLEAN NOT NULL DEFAULT false,
    "supermemoryId" TEXT,
    "ragId" TEXT,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
