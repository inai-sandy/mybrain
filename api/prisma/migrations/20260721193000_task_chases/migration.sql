-- BEA-1021: a chase belongs to a task.
--   * Reminder.taskId becomes a real link (delete the task, the chase goes with it).
--   * Reminder.repeat: "none" keeps every existing reminder on the old one-day lifecycle;
--     "daily" is a real chase that repeats until the task is confirmed done.
--
-- SAFETY: 2 live reminders point at tasks that no longer exist. Those dead pointers are cleared
-- FIRST — the reminder itself is kept, it just stops referring to something that isn't there.
-- Without this the new link would be left dangling.
UPDATE "Reminder" SET "taskId" = NULL
 WHERE "taskId" IS NOT NULL
   AND "taskId" NOT IN (SELECT "id" FROM "Task");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Reminder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "contactId" TEXT NOT NULL,
    "taskId" TEXT,
    "repeat" TEXT NOT NULL DEFAULT 'none',
    "subject" TEXT,
    "message" TEXT NOT NULL,
    "notes" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "times" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "feedback" TEXT,
    "lastFiredKey" TEXT,
    "armedDay" TEXT,
    "pausedAuto" BOOLEAN NOT NULL DEFAULT false,
    "needsOwner" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Reminder_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Reminder_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Reminder" ("armedDay", "contactId", "count", "createdAt", "feedback", "id", "lastFiredKey", "message", "needsOwner", "notes", "pausedAuto", "status", "subject", "taskId", "times", "updatedAt") SELECT "armedDay", "contactId", "count", "createdAt", "feedback", "id", "lastFiredKey", "message", "needsOwner", "notes", "pausedAuto", "status", "subject", "taskId", "times", "updatedAt" FROM "Reminder";
DROP TABLE "Reminder";
ALTER TABLE "new_Reminder" RENAME TO "Reminder";
CREATE INDEX "Reminder_contactId_idx" ON "Reminder"("contactId");
CREATE INDEX "Reminder_status_idx" ON "Reminder"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

