-- BEA-1019: a task can really belong to a person.
--   * Task.ownerContactId — the contact who owns this task (null = the owner's own task).
--   * TaskPerson         — everyone else the task touches (the @mentions), linked both ways.
-- Additive only. Every existing Task column is carried across unchanged; the live table was
-- verified column-for-column against this list before the migration was written, and the only
-- index on Task is the implicit primary key, which the rebuild recreates.

-- CreateTable
CREATE TABLE "TaskPerson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskPerson_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TaskPerson_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    CONSTRAINT "Task_ownerContactId_fkey" FOREIGN KEY ("ownerContactId") REFERENCES "Contact" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Task" ("actualMin", "category", "completedAt", "createdAt", "day", "dueDate", "dumpId", "estimateMin", "followUp", "id", "note", "party", "pinned", "priority", "progress", "ragId", "reminderCount", "reminderSuggestDismissed", "reminders", "rolloverCount", "sphere", "status", "supermemoryId", "tags", "title") SELECT "actualMin", "category", "completedAt", "createdAt", "day", "dueDate", "dumpId", "estimateMin", "followUp", "id", "note", "party", "pinned", "priority", "progress", "ragId", "reminderCount", "reminderSuggestDismissed", "reminders", "rolloverCount", "sphere", "status", "supermemoryId", "tags", "title" FROM "Task";
DROP TABLE "Task";
ALTER TABLE "new_Task" RENAME TO "Task";
CREATE INDEX "Task_ownerContactId_idx" ON "Task"("ownerContactId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "TaskPerson_contactId_idx" ON "TaskPerson"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskPerson_taskId_contactId_key" ON "TaskPerson"("taskId", "contactId");
