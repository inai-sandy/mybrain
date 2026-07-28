-- BEA-1159: everything a staff member says, from either channel, as one record.
CREATE TABLE "TeamUpdate" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "contactId" TEXT NOT NULL,
  "taskId"    TEXT,
  "channel"   TEXT NOT NULL,
  "text"      TEXT NOT NULL,
  "reads"     TEXT NOT NULL,
  "needsYou"  BOOLEAN NOT NULL DEFAULT false,
  "why"       TEXT,
  "at"        DATETIME NOT NULL,
  "closedAt"  DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeamUpdate_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TeamUpdate_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "TeamUpdate_contactId_idx" ON "TeamUpdate"("contactId");
CREATE INDEX "TeamUpdate_needsYou_closedAt_idx" ON "TeamUpdate"("needsYou", "closedAt");
CREATE INDEX "TeamUpdate_at_idx" ON "TeamUpdate"("at");
