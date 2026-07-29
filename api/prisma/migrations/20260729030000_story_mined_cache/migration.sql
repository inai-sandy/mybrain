-- The deep read of a day's story, cached against the story it came from (BEA-1164).
ALTER TABLE "Story" ADD COLUMN "mined" TEXT;
ALTER TABLE "Story" ADD COLUMN "minedHash" TEXT;
ALTER TABLE "Story" ADD COLUMN "minedAt" DATETIME;
