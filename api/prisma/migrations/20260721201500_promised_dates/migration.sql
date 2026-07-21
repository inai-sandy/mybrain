-- BEA-1022: a promised date slows the chase to once a day until then. Additive columns on Task;
-- every existing column is carried across.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Task" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "category" TEXT,
    "tags" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'medium',
    "sphere" TEXT NOT NULL DEFAULT 'work',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "estimateMin" INTEGER,
    "actualMin" INTEGER,
    "reminderCount" INTEGER NOT NULL DEFAULT 0,
    "reminders" TEXT,
    "day" TEXT,
    "dumpId" TEXT,
    "party" TEXT,
    "ownerContactId" TEXT,
    "promisedFor" TEXT,
    "promisedAt" DATETIME,
    "promiseSlips" INTEGER NOT NULL DEFAULT 0,
    "briefingId" TEXT,
    "reminderSuggestDismissed" BOOLEAN NOT NULL DEFAULT false,
    "dueDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'open',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "followUp" BOOLEAN NOT NULL DEFAULT false,
    "rolloverCount" INTEGER NOT NULL DEFAULT 0,
    "supermemoryId" TEXT,
    "ragId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "Task_ownerContactId_fkey" FOREIGN KEY ("ownerContactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Task_briefingId_fkey" FOREIGN KEY ("briefingId") REFERENCES "Briefing" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("actualMin", "briefingId", "category", "completedAt", "createdAt", "day", "dueDate", "dumpId", "estimateMin", "followUp", "id", "note", "ownerContactId", "party", "pinned", "priority", "progress", "ragId", "reminderCount", "reminderSuggestDismissed", "reminders", "rolloverCount", "sphere", "status", "supermemoryId", "tags", "title") SELECT "actualMin", "briefingId", "category", "completedAt", "createdAt", "day", "dueDate", "dumpId", "estimateMin", "followUp", "id", "note", "ownerContactId", "party", "pinned", "priority", "progress", "ragId", "reminderCount", "reminderSuggestDismissed", "reminders", "rolloverCount", "sphere", "status", "supermemoryId", "tags", "title" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_ownerContactId_idx" ON "Task"("ownerContactId");
CREATE INDEX "Task_briefingId_idx" ON "Task"("briefingId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

