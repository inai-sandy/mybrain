-- BEA-1142: nothing surfaces until it has been true on 3+ SEPARATE days.
-- evidenceCount can bump twice in one day, so it was never a count of days.
ALTER TABLE "MindFinding" ADD COLUMN "daysSeen" INTEGER NOT NULL DEFAULT 1;

-- Backfill from the evidence actually on record: how many distinct days back each finding.
UPDATE "MindFinding" SET "daysSeen" = COALESCE(
  (SELECT COUNT(DISTINCT e."day") FROM "MindEvidence" e WHERE e."findingId" = "MindFinding"."id" AND e."day" IS NOT NULL),
  1
);
UPDATE "MindFinding" SET "daysSeen" = 1 WHERE "daysSeen" < 1;
