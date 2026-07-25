-- BEA-1117: two kinds of work. `assignment` finishes once and the chase ends; `recurring` is a
-- standing daily report that NEVER completes — a status satisfies today only. Everything existing
-- stays an assignment, so no chase changes behaviour until a task is deliberately marked recurring.
ALTER TABLE "Task" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'assignment';

-- One row per recurring task per local day: did today's status arrive? The day is the unit of
-- truth for recurring work, and this is what the end-of-day miss summary reads.
CREATE TABLE "TaskStatusDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'received',
    "quote" TEXT,
    "contactId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskStatusDay_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TaskStatusDay_taskId_day_key" ON "TaskStatusDay"("taskId", "day");
CREATE INDEX "TaskStatusDay_day_idx" ON "TaskStatusDay"("day");
CREATE INDEX "TaskStatusDay_taskId_idx" ON "TaskStatusDay"("taskId");
