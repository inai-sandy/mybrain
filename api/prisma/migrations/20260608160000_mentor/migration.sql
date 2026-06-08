-- Mentor Mode: focus areas + per-day adherence/guidance
CREATE TABLE "FocusArea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'derived',
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE TABLE "MentorDay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "adherenceScore" INTEGER NOT NULL,
    "moodScore" INTEGER,
    "guidance" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "MentorDay_day_key" ON "MentorDay"("day");
