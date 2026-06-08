-- The nightly "Story of the Day" woven from story + tasks + activity
CREATE TABLE "DayStory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "day" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "mood" TEXT,
    "moodScore" INTEGER,
    "model" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "DayStory_day_key" ON "DayStory"("day");
