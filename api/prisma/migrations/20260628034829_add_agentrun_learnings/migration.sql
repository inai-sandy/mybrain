-- Additive (BEA-624): proposed learnings per run.
ALTER TABLE "AgentRun" ADD COLUMN "learnings" TEXT NOT NULL DEFAULT '[]';
