-- Replace-on-edit for derived story content: link columns so re-index replaces (no dupes). (BEA-342)
ALTER TABLE "DayStory" ADD COLUMN "supermemoryId" TEXT;
ALTER TABLE "DayStory" ADD COLUMN "ragId" TEXT;
ALTER TABLE "MonthStory" ADD COLUMN "supermemoryId" TEXT;
ALTER TABLE "MonthStory" ADD COLUMN "ragId" TEXT;
ALTER TABLE "YearStory" ADD COLUMN "supermemoryId" TEXT;
ALTER TABLE "YearStory" ADD COLUMN "ragId" TEXT;
