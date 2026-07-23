-- Deep story mining (BEA-1051): the day's emotions live on the Story row; life events mined from
-- the story get their own table so the Activity timeline can show the owner's real day.
ALTER TABLE "Story" ADD COLUMN "emotions" TEXT;
CREATE TABLE "DayEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "day" TEXT NOT NULL,
  "at" TEXT,
  "title" TEXT NOT NULL,
  "detail" TEXT,
  "source" TEXT NOT NULL DEFAULT 'story',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DayEvent_day_idx" ON "DayEvent"("day");
