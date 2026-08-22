-- What a tool taught us by being used (BEA-1409) — derived mechanically, never by a model.
CREATE TABLE "ToolLesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "actionId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "param" TEXT,
    "callId" TEXT,
    "sampleId" TEXT,
    "timesSeen" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastConfirmedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ToolLesson_actionId_key_key" ON "ToolLesson"("actionId", "key");
CREATE INDEX "ToolLesson_actionId_idx" ON "ToolLesson"("actionId");
CREATE INDEX "ToolLesson_lastConfirmedAt_idx" ON "ToolLesson"("lastConfirmedAt");
