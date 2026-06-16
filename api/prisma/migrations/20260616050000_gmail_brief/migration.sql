-- CreateTable
CREATE TABLE "GmailBrief" (
    "day" TEXT NOT NULL PRIMARY KEY,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL DEFAULT '',
    "items" TEXT,
    "model" TEXT,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
