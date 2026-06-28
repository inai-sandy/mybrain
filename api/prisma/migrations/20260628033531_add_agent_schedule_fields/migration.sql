-- Additive only: new optional columns on Agent for scheduling (BEA-623).
ALTER TABLE "Agent" ADD COLUMN "prompt" TEXT;
ALTER TABLE "Agent" ADD COLUMN "lastFiredKey" TEXT;
