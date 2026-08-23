-- What a trial READ, before filtering (BEA-1416) — "read 15, kept 5", not "got 1 thing".
ALTER TABLE "AgentTrial" ADD COLUMN "fetched" INTEGER NOT NULL DEFAULT 0;
