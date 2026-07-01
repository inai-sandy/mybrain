-- Schedule a flow to run on a timer (Phase-2 Stage 3)
ALTER TABLE "Flow" ADD COLUMN "schedule" TEXT;
ALTER TABLE "Flow" ADD COLUMN "lastFiredKey" TEXT;
